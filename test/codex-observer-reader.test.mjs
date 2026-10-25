import { feature, unit, expect } from "bdd-vitest";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alternateSessionReader } from "../core/alternate-session-reader.mjs";
import { createCodexObserverReader } from "../core/codex-observer-reader.mjs";

function scenario(work) {
  const home = fs.mkdtempSync(join(tmpdir(), "amux-observer-index-"));
  const previous = { HOME: process.env.HOME, CODEX_HOME: process.env.CODEX_HOME };
  process.env.HOME = home; process.env.CODEX_HOME = join(home, ".codex");
  const root = join(home, ".codex", "sessions"), day = join(root, "2026", "10", "25");
  fs.mkdirSync(day, { recursive: true });
  const panes = [join(home, "workspace", ".agents", "0"), join(home, "workspace", ".agents", "1")];
  const write = (name, pane, folder = day) => {
    const path = join(folder, name + ".jsonl");
    fs.writeFileSync(path, JSON.stringify({ type: "session_meta", payload: { cwd: pane, source: "cli", originator: "codex-tui" } }) + "\n");
    return path;
  };
  write("first", panes[0]); write("second", panes[1]);
  const original = fs.readdirSync;
  let scans = 0;
  fs.readdirSync = (path, options) => { if (path === root) scans++; return original(path, options); };
  syncBuiltinESMExports();
  try { return work({ panes, write, root, scans: () => scans }); }
  finally {
    fs.readdirSync = original; syncBuiltinESMExports();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(home, { recursive: true, force: true });
  }
}

feature("bounded Codex observation discovery", () => {
  unit("observers share one archive scan while real session lookup stays fresh", {
    when: ["reading two panes repeatedly then using the ordinary physical reader", () => scenario(ctx => {
      const reader = alternateSessionReader("codex", { observe: true });
      reader.latestInfo(ctx.panes[0]); reader.latestInfo(ctx.panes[1]); reader.latestMtime(ctx.panes[0]);
      const observedScans = ctx.scans();
      alternateSessionReader("codex").latestInfo(ctx.panes[0]);
      return { observedScans, physicalScans: ctx.scans() };
    })],
    then: ["observations reuse discovery and transport performs an independent scan", result => {
      expect(result).toEqual({ observedScans: 1, physicalScans: 2 });
    }],
  });
  unit("a new rollout invalidates observations immediately", {
    when: ["a session is created within the observation window", () => scenario(ctx => {
      const reader = alternateSessionReader("codex", { observe: true });
      reader.latestInfo(ctx.panes[0]);
      const next = ctx.write("new-session", ctx.panes[0]);
      fs.utimesSync(next, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
      return { expected: next, actual: reader.latestInfo(ctx.panes[0]).path };
    })],
    then: ["a profile or session change is visible without waiting for the cache age", result => expect(result.actual).toBe(result.expected)],
  });
  unit("a configured profile root becoming available invalidates immediately", {
    when: ["a missing configured session root is created", () => scenario(ctx => {
      const extra = ctx.root + "-other-profile";
      const reader = createCodexObserverReader({ roots: () => [ctx.root, extra] });
      reader.latestInfo(ctx.panes[0]);
      fs.mkdirSync(extra);
      const next = ctx.write("new-profile", ctx.panes[0], extra);
      fs.utimesSync(next, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
      return { expected: next, actual: reader.latestInfo(ctx.panes[0]).path };
    })],
    then: ["no old profile masks the new rollout", result => expect(result.actual).toBe(result.expected)],
  });
  unit("a resumed existing rollout uses fresh activity even inside the observation window", {
    when: ["an older matching session becomes active without a directory change", () => scenario(ctx => {
      const resumed = ctx.write("resumed", ctx.panes[0]);
      fs.utimesSync(resumed, new Date(1000), new Date(1000));
      const reader = createCodexObserverReader({ roots: () => [ctx.root] });
      reader.latestInfo(ctx.panes[0]);
      fs.utimesSync(resumed, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
      return { expected: resumed, actual: reader.latestInfo(ctx.panes[0]).path };
    })],
    then: ["the active session wins immediately", result => expect(result.actual).toBe(result.expected)],
  });
  unit("a slow capture does not expire its own reuse window", {
    when: ["capturing takes longer than the reuse age", () => {
      let clock = 0, captures = 0;
      const reader = createCodexObserverReader({ roots: () => [], now: () => clock,
        capture: () => { captures++; clock += 300; return { files: [], directories: [] }; } });
      reader.latestInfo("/no-pane"); reader.latestMtime("/no-pane");
      const warm = captures; clock += 251; reader.latestInfo("/no-pane");
      return { warm, afterExpiry: captures };
    }],
    then: ["capture completion starts the bounded window", result => expect(result).toEqual({ warm: 1, afterExpiry: 2 })],
  });
});
