import { component, expect, feature } from "bdd-vitest";
import { afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { claudeProcessStartMs, claudeSubagentHook } from "../core/claude-subagent-cap.mjs";

const refusal = "One subagent at a time. Follow the amux handoff policy for an available authorized builder; keep visual and gameplay judgment with its owner.";
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
  // lsrc:0 2026-10-20: a stopped or finished agent frees its slot. sandman:0's floor agent, ended by TaskStop at
  // 21:23Z on 2026-10-19, got no SubagentStop and held the pane's only slot for hours.
  component("an agent TaskStop ended frees its slot", {
    when: ["a background agent starts and TaskStop ends it", () => {
      const f = fixture();
      f.spawn("first", { tool_input: { description: "Background", run_in_background: true } });
      f.call("SubagentStart", null, { agent_id: "child-1", agent_type: "general-purpose" });
      f.call("PostToolUse", "first");
      f.call("PostToolUse", "stop", { tool_name: "TaskStop", tool_input: { task_id: "child-1" } });
      return f.spawn("second").status;
    }],
    then: ["the next spawn is admitted", status => expect(status).toBe(0)],
  });
  component("a started or resumed Claude process begins with no slots", {
    when: ["a background agent runs, then the pane's Claude resumes its session", () => {
      const f = fixture();
      f.spawn("first", { tool_input: { description: "Background", run_in_background: true } });
      f.call("SubagentStart", null, { agent_id: "child-1", agent_type: "general-purpose" });
      f.call("PostToolUse", "first");
      const before = f.spawn("blocked").status;
      f.call("SessionStart", null, { source: "resume" });
      return [before, f.spawn("second").status];
    }],
    then: ["refused while it ran, admitted after the restart", statuses => expect(statuses).toEqual([2, 0])],
  });
});

// lsrc:0 2026-10-20: a slot whose agent no longer exists is freed on the next admission check.
feature("admission frees slots whose agents no longer exist", () => {
  const STARTED = Date.parse("2026-10-19T18:47:36Z");
  const setup = () => {
    const home = mkdtempSync(join(tmpdir(), "amux-subagent-live-")); homes.push(home);
    mkdirSync(join(home, ".agentmux"));
    const project = join(home, "projects", "pane");
    mkdirSync(join(project, "session", "subagents"), { recursive: true });
    const transcript = join(project, "session.jsonl");
    writeFileSync(transcript, "");
    const hook = (event, extra = {}, claudeStartMs = () => STARTED) => claudeSubagentHook({ hook_event_name: event,
      session_id: "session", transcript_path: transcript, tool_name: "Agent", ...extra }, { pane: "test:0", home, env: {}, claudeStartMs });
    const start = async (id, agent) => {
      await hook("PreToolUse", { tool_use_id: id, tool_input: { description: id, subagent_type: "Explore", run_in_background: true } });
      await hook("SubagentStart", { agent_id: agent, agent_type: "Explore" });
      await hook("PostToolUse", { tool_use_id: id });
    };
    const journal = (agent, at) => {
      const path = join(project, "session", "subagents", `agent-${agent}.jsonl`);
      writeFileSync(path, "{}\n");
      utimesSync(path, new Date(at), new Date(at));
    };
    const notify = (agent, at) => writeFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue",
      timestamp: new Date(at).toISOString(), content: `<task-notification>\n<task-id>${agent}</task-id>\n<status>killed</status>\n`
        + "<summary>Agent was stopped</summary>\n</task-notification>" })}\n`, { flag: "a" });
    return { hook, start, journal, notify };
  };
  const admitted = async (ctx, id) => (await ctx.hook("PreToolUse", { tool_use_id: id, tool_input: { description: id } })).allowed;

  component("a stop notification in the parent journal frees the slot, and a later restart of that agent counts again", {
    when: ["an agent is stopped without a receipt, then resumed", async () => {
      const ctx = setup();
      await ctx.start("first", "child-1");
      ctx.journal("child-1", Date.now());
      const whileRunning = await admitted(ctx, "blocked");
      ctx.notify("child-1", Date.now() + 1000);
      const afterStop = await admitted(ctx, "second");
      await ctx.hook("PostToolUseFailure", { tool_use_id: "second" });
      await new Promise(done => setTimeout(done, 1100));
      await ctx.hook("SubagentStart", { agent_id: "child-1", agent_type: "Explore" });
      return [whileRunning, afterStop, await admitted(ctx, "third")];
    }],
    then: ["refused, admitted, refused", results => expect(results).toEqual([false, true, false])],
  });
  component("an agent of an earlier Claude process frees its slot, while one of the current process still counts", {
    when: ["two panes' agents last wrote before and after their Claude process started", async () => {
      const earlier = setup();
      await earlier.start("first", "child-1");
      earlier.journal("child-1", STARTED - 3 * 3600_000);
      const current = setup();
      await current.start("first", "child-2");
      current.journal("child-2", STARTED + 60_000);
      return [await admitted(earlier, "second"), await admitted(current, "second")];
    }],
    then: ["the earlier one is freed, the current one is refused", results => expect(results).toEqual([true, false])],
  });
  component("the Claude process is the first one named claude above the hook", {
    when: ["a hook runs under sh -c under claude, with boot at 1 000 000 s", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-proc-")); homes.push(root);
      writeFileSync(join(root, "stat"), "cpu 1 2 3\nbtime 1000000\n");
      const proc = (pid, ppid, start, command) => {
        mkdirSync(join(root, String(pid)));
        writeFileSync(join(root, String(pid), "stat"), `${pid} (${command.split("/").at(-1)}) S ${ppid} ${"0 ".repeat(17)}${start} 0 0\n`);
        writeFileSync(join(root, String(pid), "cmdline"), `${command}\0--resume\0`);
      };
      proc(30, 20, 9000, "/bin/sh"); proc(20, 10, 5000, "/home/u/.local/bin/claude"); proc(10, 1, 100, "/usr/bin/tmux");
      return claudeProcessStartMs(root, 30);
    }],
    then: ["claude's start, 50 s after boot", started => expect(started).toBe(1_000_000_000 + 50_000)],
  });
});
