// Incident 2026-10-10 (skyvw): a 4-pane window wanted 12. A failed pane
// count was treated as "1 pane", reconcile split `.0` eight times, and tmux
// inserted each new shell after pane 0. Live agents 1-3 moved to 9-11, and a
// Discord /compact to the shell at `.2` resumed a Claude session that was
// still running in `.10`. These tests replay that window against a tmux fake
// that keeps real tmux semantics: a split pane lands right after its target,
// pane ids are stable, indexes are positions.

import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import yaml from "js-yaml";
import { createAgent } from "../agent.mjs";

const SESSION_ID = "80d2a76a-5c1e-4f6b-9a3d-2b7e4c1f0a99";

function tmuxWindow({ panes, insertAfter = (index) => index + 1 }) {
  const calls = [];
  const state = { panes, hiccup: false };
  let nextId = 100;
  const indexOf = (target) => /^%\d+$/u.test(target)
    ? state.panes.findIndex((pane) => pane.id === target)
    : Number(target.match(/:\.(\d+)$/u)?.[1] ?? -1);
  const exec = async (command) => {
    calls.push(command);
    const body = command.replace(/^tmux -S '[^']*' /u, "");
    const target = body.match(/-t '([^']+)'/u)?.[1] || "";
    if (body.startsWith("list-panes")) {
      if (state.hiccup) throw new Error("Command failed: tmux list-panes (timed out after 3000 ms)");
      const rows = state.panes.map((pane, index) => body.includes(" -F ")
        ? `${index}|${pane.id}|0|${pane.cmd}|${pane.path}`
        : `${index}: [80x24] [history 0/2000, 0 bytes] ${pane.id}`);
      return { stdout: `${rows.join("\n")}\n` };
    }
    if (body.startsWith("split-window")) {
      const at = indexOf(target);
      if (at < 0 || at >= state.panes.length) throw new Error(`can't find pane: ${target}`);
      state.panes.splice(insertAfter(at), 0, { id: `%${nextId++}`, cmd: "bash", path: body.match(/-c '([^']+)'/u)[1] });
      return { stdout: "" };
    }
    if (body.startsWith("send-keys") && /claude|codex/u.test(body)) {
      const pane = state.panes[indexOf(target)];
      if (pane) pane.cmd = "claude";
    }
    if (body.startsWith("capture-pane")) return { stdout: "❯ \n" };
    if (body.startsWith("display-message")) {
      const pane = state.panes[indexOf(target)];
      if (body.includes("#{pane_current_command}")) return { stdout: `${pane?.cmd ?? ""}\n` };
      if (body.includes("#{session_attached}")) return { stdout: "1\n" };
      return { stdout: "0\n" };
    }
    return { stdout: "" };
  };
  return { exec, calls, state };
}

// Config wants 12 panes: three Claude, one Codex, eight shells.
function skyvw({ panes, insertAfter, live = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-pane-safety-"));
  const procRoot = join(root, "proc");
  mkdirSync(procRoot);
  live.forEach((argv, pid) => {
    mkdirSync(join(procRoot, String(1000 + pid)));
    writeFileSync(join(procRoot, String(1000 + pid), "cmdline"), `${argv.join("\0")}\0`);
  });
  const dir = join(root, "repo");
  const configPath = join(root, "agents.yaml");
  const cmds = ["claude", "claude", "claude", "codex", ...Array(8).fill("bash")];
  writeFileSync(configPath, yaml.dump({ skyvw: { dir, panes: cmds.map((cmd, index) => ({
    name: `p${index}`, cmd, ...(index === 2 ? { resumeSessionId: SESSION_ID } : {}),
  })) } }));
  const at = (index) => join(dir, ".agents", String(index));
  const window = tmuxWindow({
    panes: (panes || [
      { id: "%0", cmd: "claude", path: at(0) },
      { id: "%1", cmd: "claude", path: at(1) },
      { id: "%2", cmd: "claude", path: at(2) },
      { id: "%3", cmd: "node", path: at(3) },
    ]).map((pane) => ({ ...pane, path: pane.path || at(pane.dir) })),
    insertAfter,
  });
  const agent = createAgent({
    tmuxSocket: "/tmp/amux-pane-safety.sock", configPath, timeout: 10_000,
    tmuxExec: window.exec, run: async () => ({ stdout: "" }), delay: async () => {}, procRoot,
  });
  return { agent, window, at, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const splits = (calls) => calls.filter((call) => call.includes("split-window"));
const launches = (calls, pane) => calls.filter((call) =>
  call.includes(`send-keys -t 'skyvw:.${pane}'`) && /claude|codex/u.test(call));
const layout = (window) => window.state.panes.map((pane) => pane.id);

feature("pane provisioning never moves a live agent", () => {
  component("an unreadable pane count adds no pane", {
    given: ["a live 4-pane window that wants 12, while list-panes times out", () => {
      const fx = skyvw();
      fx.window.state.hiccup = true;
      return fx;
    }],
    when: ["reconciling the window", (fx) => fx.agent.reconcileSession("skyvw").catch((error) => error)],
    then: ["reconcile refuses loudly and tmux is never split", (error, fx) => {
      try {
        expect(splits(fx.window.calls)).toEqual([]);
        expect(layout(fx.window)).toEqual(["%0", "%1", "%2", "%3"]);
        expect(error).toMatchObject({ code: "AMUX_PANE_LAYOUT_UNSAFE" });
        expect(error.message).toContain("cannot count panes in 'skyvw'");
      } finally { fx.cleanup(); }
    }],
  });

  component("missing panes are appended after the live ones", {
    given: ["the same window; the first delivery lands during a tmux hiccup", () => skyvw()],
    when: ["one delivery during the hiccup, then one after tmux recovers", async (fx) => {
      fx.window.state.hiccup = true;
      const first = await fx.agent.ensureReady("skyvw", 2).catch((error) => error);
      fx.window.state.hiccup = false;
      await fx.agent.ensureReady("skyvw", 2);
      return { first };
    }],
    then: ["live pane ids keep 0-3, new shells take 4-11 in their own dirs", ({ first }, fx) => {
      try {
        expect(layout(fx.window).slice(0, 4)).toEqual(["%0", "%1", "%2", "%3"]);
        expect(fx.window.state.panes.slice(4).map((pane) => pane.path))
          .toEqual(Array.from({ length: 8 }, (_, index) => fx.at(index + 4)));
        expect(launches(fx.window.calls, 2)).toEqual([]);
        expect(first).toMatchObject({ code: "AMUX_PANE_LAYOUT_UNSAFE" });
      } finally { fx.cleanup(); }
    }],
  });

  component("a split that shifts a live pane stops growth at once", {
    given: ["a tmux that inserts every new pane at index 0", () => skyvw({ insertAfter: () => 0 })],
    when: ["reconciling the window", (fx) => fx.agent.reconcileSession("skyvw").catch((error) => error)],
    then: ["one split, then a loud refusal naming the moved panes", (error, fx) => {
      try {
        expect(splits(fx.window.calls)).toHaveLength(1);
        expect(error).toMatchObject({ code: "AMUX_PANE_LAYOUT_UNSAFE" });
        expect(error.message).toContain("%0 0->1");
      } finally { fx.cleanup(); }
    }],
  });
});

feature("an engine session is never started twice", () => {
  // The window as it stood at 20:14: pane 2 a shell, the agent-2 Claude in pane 10.
  const renumbered = () => [
    { id: "%0", cmd: "claude", dir: 0 }, { id: "%57", cmd: "bash", dir: 1 },
    { id: "%58", cmd: "bash", dir: 2 }, { id: "%59", cmd: "bash", dir: 3 },
    ...[4, 5, 6, 7, 8].map((dir) => ({ id: `%6${dir}`, cmd: "bash", dir })),
    { id: "%22", cmd: "claude", dir: 1 }, { id: "%23", cmd: "claude", dir: 2 }, { id: "%24", cmd: "node", dir: 3 },
  ];

  component("a pane whose agent already runs in another pane is not started", {
    given: ["the renumbered window, no other process holding the session", () => skyvw({ panes: renumbered() })],
    when: ["a /compact delivery wakes pane 2", (fx) => fx.agent.ensureReady("skyvw", 2).catch((error) => error)],
    then: ["the start is refused and nothing is typed into pane 2", (error, fx) => {
      try {
        expect(launches(fx.window.calls, 2)).toEqual([]);
        expect(error).toMatchObject({ code: "AMUX_ENGINE_START_REFUSED" });
        expect(error.message).toContain("skyvw:10 (%23, claude) already runs from");
      } finally { fx.cleanup(); }
    }],
  });

  component("a resume of a session live in another process is refused", {
    given: ["pane 2 is a shell and a Claude process outside the window holds its session", () => skyvw({
      panes: Array.from({ length: 12 }, (_, dir) => ({ id: `%${dir}`, cmd: dir === 2 ? "bash" : "claude", dir })),
      live: [["/home/u/.local/bin/claude", "--dangerously-skip-permissions", "--resume", SESSION_ID]],
    })],
    when: ["a delivery wakes pane 2", (fx) => fx.agent.ensureReady("skyvw", 2).catch((error) => error)],
    then: ["claude --resume is never typed", (error, fx) => {
      try {
        expect(launches(fx.window.calls, 2)).toEqual([]);
        expect(error).toMatchObject({ code: "AMUX_ENGINE_START_REFUSED" });
        expect(error.message).toContain(`claude session ${SESSION_ID} is still held by another live process`);
      } finally { fx.cleanup(); }
    }],
  });

  component("a free session still starts", {
    given: ["pane 2 is a shell and no process holds its session", () => skyvw({
      panes: Array.from({ length: 12 }, (_, dir) => ({ id: `%${dir}`, cmd: dir === 2 ? "bash" : "claude", dir })),
    })],
    when: ["a delivery wakes pane 2", (fx) => fx.agent.ensureReady("skyvw", 2).catch((error) => error)],
    then: ["the exact resume is typed once", (_result, fx) => {
      try {
        const typed = launches(fx.window.calls, 2);
        expect(typed).toHaveLength(1);
        expect(typed[0]).toContain(`--resume '${SESSION_ID}'`);
      } finally { fx.cleanup(); }
    }],
  });
});
