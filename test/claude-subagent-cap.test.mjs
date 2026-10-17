import { component, expect, feature } from "bdd-vitest";
import { afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const refusal = "One subagent at a time. Hand mechanical work to a free Codex pane with a brief (policy: Opus designs; Codex implements).";
const homes = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const fixture = (cap) => {
  const home = mkdtempSync(join(tmpdir(), "amux-subagent-cap-")); homes.push(home);
  mkdirSync(join(home, ".agentmux"));
  if (cap !== undefined) writeFileSync(join(home, ".agentmux", ".env"), `AMUX_CLAUDE_SUBAGENT_CAP=${cap}\n`);
  const call = (event, id, extra = {}) => spawnSync(process.execPath, [resolve("bin/fork-guard.mjs")], {
    encoding: "utf8", env: { ...process.env, HOME: home, AMUX_AGENT_NAME: "test", AMUX_PANE: "0" },
    input: JSON.stringify({ hook_event_name: event, session_id: "session", tool_name: "Agent", tool_use_id: id,
      tool_input: { description: `Check ${id}`, prompt: "PRIVATE PROMPT MUST NEVER BE LOGGED", subagent_type: "general-purpose" }, ...extra }),
  });
  const spawn = (id, extra) => call("PreToolUse", id, extra);
  const log = () => readFileSync(join(home, ".agentmux", "subagent-spawns.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return { home, call, spawn, log };
};

feature("Claude pane subagent admission", () => {
  component("the first starts, the second is refused while it runs, and completion frees the slot", {
    when: ["two starts around the actual lifecycle hooks", () => {
      const f = fixture();
      const first = f.spawn("first");
      f.call("SubagentStart", null, { agent_id: "child-1", agent_type: "general-purpose" });
      const second = f.spawn("second", { tool_name: "Task" });
      f.call("SubagentStop", null, { agent_id: "child-1" });
      return { first, second, third: f.spawn("third"), log: f.log() };
    }],
    then: ["one running child, exact refusal and one prompt-free row per attempt", ({ first, second, third, log }) => {
      expect(first.status).toBe(0); expect(second.status).toBe(2); expect(second.stderr.trim()).toBe(refusal);
      expect(third.status).toBe(0);
      expect(log.map(row => [row.pane, row.allowed, row.description])).toEqual([
        ["test:0", true, "Check first"], ["test:0", false, "Check second"], ["test:0", true, "Check third"],
      ]);
      expect(log.every(row => Number.isFinite(Date.parse(row.time)))).toBe(true);
      expect(JSON.stringify(log)).not.toContain("PRIVATE PROMPT");
    }],
  });
  component("the pending first admission already counts before SubagentStart", {
    when: ["a second Agent call arrives before the start callback", () => {
      const f = fixture(); return [f.spawn("first").status, f.spawn("second").status];
    }],
    then: ["the reservation closes the parallel-spawn gap", statuses => expect(statuses).toEqual([0, 2])],
  });
  component("simultaneous hook processes share one slot", {
    when: ["two independent PreToolUse processes race", async () => {
      const f = fixture();
      return Promise.all(["left", "right"].map(id => new Promise(done => {
        const child = spawn(process.execPath, [resolve("bin/fork-guard.mjs")], {
          env: { ...process.env, HOME: f.home, AMUX_AGENT_NAME: "test", AMUX_PANE: "0" }, stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("exit", code => done(code));
        child.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "session", tool_name: "Agent", tool_use_id: id,
          tool_input: { description: id, subagent_type: "general-purpose" } }));
      })));
    }],
    then: ["exactly one admission succeeds", codes => expect(codes.sort()).toEqual([0, 2])],
  });
  component("operator cap zero disables the limit, and a higher cap permits that many", {
    when: ["the cap comes from the existing user env file", () => [0, 2].map(cap => {
      const f = fixture(cap); return [f.spawn("one").status, f.spawn("two").status, f.spawn("three").status];
    })],
    then: ["off and two are distinct", result => expect(result).toEqual([[0, 0, 0], [0, 0, 2]])],
  });
  component("unknown counting fails open and records the uncertainty without the prompt", {
    when: ["the state directory cannot be created", () => {
      const f = fixture(); writeFileSync(join(f.home, ".agentmux", "subagent-cap"), "not a directory");
      return { result: f.spawn("unknown"), log: f.log() };
    }],
    then: ["the attempted spawn is allowed with an explicit unknown row", ({ result, log }) => {
      expect(result.status).toBe(0); expect(log).toHaveLength(1);
      expect(log[0]).toMatchObject({ allowed: true, countKnown: false, description: "Check unknown" });
      expect(JSON.stringify(log)).not.toContain("PRIVATE PROMPT");
    }],
  });
  component("foreground completion and failed calls release pending admissions, background launch does not", {
    when: ["the existing tool hooks report completion or failure", () => {
      const f = fixture(); f.spawn("foreground"); f.call("PostToolUse", "foreground");
      const afterForeground = f.spawn("failed").status; f.call("PostToolUseFailure", "failed");
      const background = f.spawn("background", { tool_input: { description: "Background", run_in_background: true } }).status;
      f.call("PostToolUse", "background");
      return [afterForeground, background, f.spawn("blocked").status];
    }],
    then: ["only running background work still holds the slot", result => expect(result).toEqual([0, 0, 2])],
  });
});
