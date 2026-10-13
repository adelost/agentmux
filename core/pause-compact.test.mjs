import { expect, feature, unit } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAUSE_COMPACT_POLICY } from "../policies/context-cost.mjs";
import { codexBackgroundActivity, codexTerminalStarts, latestJournalCompactMs, leaderPanes, openFileHolderStarts, pauseCompactDecision, pauseCompactLimit,
  readPauseCompactModes, sessionBackgroundActivity } from "./pause-compact.mjs";

const NOW = Date.parse("2026-10-11T03:36:00Z");
const MIN = 60_000;
// A builder whose turn ended 90 s ago, over budget, with nothing in the background.
const atPause = (facts = {}) => ({ engine: "claude", tokens: 520_000, limit: 400_000, status: "idle", quietMs: 90_000,
  background: null, lastCompactAt: null, now: NOW, ...facts });
const decide = facts => pauseCompactDecision(atPause(facts));

feature("compaction at a natural pause: one guard per condition", () => {
  unit("a builder over 400k is compacted one quiet minute after its turn", {
    when: ["deciding at the pause", () => decide()],
    then: ["it compacts", result => expect(result.action).toBe("compact")],
  });
  unit("a turn that is still running is never compacted", {
    when: ["the screen shows the turn working", () => decide({ status: "working" })],
    then: ["nothing happens", result => expect(result).toMatchObject({ action: "none", cell: "turn-running" })],
  });
  unit("a turn that just ended waits out the settle minute", {
    when: ["the turn ended 30 s ago", () => decide({ quietMs: 30_000 })],
    then: ["nothing happens yet", result => expect(result).toMatchObject({ action: "none", cell: "settling" })],
  });
  unit("a working subagent or background job holds the compact", {
    when: ["the session's subagent wrote 40 s ago", () => decide({ background: "a subagent or background job wrote 40s ago" })],
    then: ["the compact is held and says why", result => expect(result).toMatchObject({ action: "hold", cell: "background-active" })],
  });
  unit("an open permission prompt holds the compact", {
    when: ["the pane asks for permission", () => decide({ status: "permission" })],
    then: ["the compact is held", result => expect(result).toMatchObject({ action: "hold", cell: "unsafe-status" })],
  });
  unit("a pane compacted within 30 minutes is held", {
    when: ["the last compact was 12 minutes ago", () => decide({ lastCompactAt: NOW - 12 * MIN })],
    then: ["the compact waits for the spacing", result => expect(result).toMatchObject({ action: "hold", cell: "spacing" })],
  });
  unit("a pane compacted 31 minutes ago may compact again", {
    when: ["the last compact was 31 minutes ago", () => decide({ lastCompactAt: NOW - 31 * MIN })],
    then: ["it compacts", result => expect(result.action).toBe("compact")],
  });
  unit("a Codex pane over the daytime budget is compacted after 25 quiet minutes", {
    when: ["deciding for Codex at 90k, 20 and 26 minutes after its turn", () => [20, 26].map(minutes =>
      decide({ engine: "codex", tokens: 90_000, idleLimit: 80_000, idleMs: 25 * MIN, quietMs: minutes * MIN }))],
    then: ["it waits at 20 and compacts against 80k at 26", ([early, due]) => {
      expect(early).toMatchObject({ action: "none", cell: "settling" });
      expect(due).toMatchObject({ action: "compact", cell: "codex-idle", budget: 80_000 });
    }],
  });
  unit("a pane first seen after its prompt cache expired is left to its next delivery", {
    when: ["a builder at 520k and a Codex pane at 90k, each quiet 61 minutes under a one-hour cache", () => [
      decide({ quietMs: 61 * MIN, cacheLifeMs: 60 * MIN }),
      decide({ engine: "codex", tokens: 90_000, idleLimit: 80_000, idleMs: 25 * MIN, quietMs: 61 * MIN, cacheLifeMs: 60 * MIN })]],
    then: ["neither compacts", results => results.forEach(result =>
      expect(result).toMatchObject({ action: "none", cell: "cache-cold" }))],
  });
  unit("a warm pause and a self-request without a cache life still compact", {
    when: ["a builder quiet 59 minutes, and one quiet 61 minutes for a self-request", () => [
      decide({ quietMs: 59 * MIN, cacheLifeMs: 60 * MIN }), decide({ quietMs: 61 * MIN })]],
    then: ["both compact", results => expect(results.map(result => result.action)).toEqual(["compact", "compact"])],
  });
  unit("a Claude pane keeps the 50-minute rule", {
    when: ["deciding for Claude at 90k, 26 minutes after its turn", () => decide({ tokens: 90_000, quietMs: 26 * MIN })],
    then: ["the pause rule leaves it to the 50-minute rule", result => expect(result).toMatchObject({ action: "none", cell: "within-budget" })],
  });
  unit("the Codex idle rule keeps every pause guard", {
    when: ["a Codex pane idle 26 minutes with a running terminal", () => decide({ engine: "codex", tokens: 90_000,
      idleLimit: 80_000, idleMs: 25 * MIN, quietMs: 26 * MIN, background: "1 Codex terminal process(es) running, the oldest for 26 min" })],
    then: ["held", result => expect(result).toMatchObject({ action: "hold", cell: "background-active" })],
  });
  unit("an engine without a compact receipt is left out", {
    when: ["a Kimi pane is over budget at a pause", () => decide({ engine: "kimi" })],
    then: ["nothing happens", result => expect(result).toMatchObject({ action: "none", cell: "no-compact-receipt" })],
  });
  unit("a leader keeps 700k", {
    given: ["skyvw orchestrated by pane 0, lsrc led by Codex pane 3 and Claude pane 0", () => ({
      skyvw: { name: "skyvw", orchestrator: 0, leaders: [] }, lsrc: { name: "lsrc", orchestrator: 3, leaders: [0] } })],
    when: ["reading the budgets", ({ skyvw, lsrc }) => ({ skyvw0: pauseCompactLimit(skyvw, 0), skyvw1: pauseCompactLimit(skyvw, 1),
      lsrc0: pauseCompactLimit(lsrc, 0), lsrc2: pauseCompactLimit(lsrc, 2), lsrcLeaders: [...leaderPanes(lsrc)] })],
    then: ["leaders get 700k, builders 400k", budgets => expect(budgets).toEqual({ skyvw0: 700_000, skyvw1: 400_000,
      lsrc0: 700_000, lsrc2: 400_000, lsrcLeaders: [3, 0] })],
  });
  unit("both engines are on after the dry run, each switchable back, and a typo fails loudly", {
    when: ["reading modes", () => ({ unset: readPauseCompactModes({}), codexDry: readPauseCompactModes({ AUTO_COMPACT_PAUSE_CODEX: "dry" }),
      bad: () => readPauseCompactModes({ AUTO_COMPACT_PAUSE_CODEX: "yes" }) })],
    then: ["on by default, Codex dry only by its own switch, a typo is refused", ({ unset, codexDry, bad }) => {
      expect(unset).toEqual({ claude: "on", codex: "on" });
      expect(codexDry).toEqual({ claude: "on", codex: "dry" });
      expect(bad).toThrow("AUTO_COMPACT_PAUSE_CODEX");
    }],
  });
});

// The five compacts skyvw:0 ran by hand on the night of 10-11 October, from the
// lsrc:0 and lsrc:2 journals (compact_boundary preTokens, quiet since the last
// turn). No subagent of either session wrote in the 15 minutes before.
const NIGHT = [
  { case: "lsrc:0 23:57Z", leader: true, tokens: 859_840, quietSec: 104, sinceLastMin: null, expected: "compact" },
  { case: "lsrc:2 01:16Z", leader: false, tokens: 783_359, quietSec: 123, sinceLastMin: 114, expected: "compact" },
  { case: "lsrc:2 02:15Z", leader: false, tokens: 520_069, quietSec: 137, sinceLastMin: 59, expected: "compact" },
  { case: "lsrc:0 03:31Z", leader: true, tokens: 517_854, quietSec: 149, sinceLastMin: 213, expected: "none" },
  { case: "lsrc:2 03:36Z", leader: false, tokens: 710_858, quietSec: 82, sinceLastMin: 80, expected: "compact" },
];

feature("the night of 10-11 October under the pause rule", () => {
  for (const night of NIGHT) {
    unit(`${night.case} at ${night.tokens} tokens: ${night.expected}`, {
      when: ["deciding with that night's facts", () => decide({ tokens: night.tokens,
        limit: night.leader ? PAUSE_COMPACT_POLICY.leaderTokens : PAUSE_COMPACT_POLICY.builderTokens,
        quietMs: night.quietSec * 1000, lastCompactAt: night.sinceLastMin == null ? null : NOW - night.sinceLastMin * MIN })],
      then: [`the rule says ${night.expected}`, result => expect(result.action).toBe(night.expected)],
    });
  }
});

function sessionTree() {
  const root = mkdtempSync(join(tmpdir(), "amux-pause-"));
  const projects = join(root, "projects", "-home-adelost-lsrc--agents-1");
  const sessionPath = join(projects, "s1.jsonl");
  const subagents = join(projects, "s1", "subagents");
  const tmpRoot = join(root, "tmp");
  const tasks = join(tmpRoot, "-home-adelost-lsrc--agents-1", "s1", "tasks");
  mkdirSync(subagents, { recursive: true });
  mkdirSync(tasks, { recursive: true });
  writeFileSync(sessionPath, "");
  const touch = (path, msAgo) => { writeFileSync(path, "x"); const t = new Date(NOW - msAgo); utimesSync(path, t, t); };
  const activity = (holderStarts = () => []) => sessionBackgroundActivity({ sessionPath, sessionId: "s1", now: NOW, tmpRoot, holderStarts });
  return { root, subagents, tasks, touch, activity, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("what the session still has running", () => {
  unit("a subagent that wrote 2 minutes ago is running", {
    given: ["lsrc:1's builder subagent", () => { const t = sessionTree(); t.touch(join(t.subagents, "agent-a.jsonl"), 2 * MIN); return t; }],
    when: ["reading activity", t => t.activity()],
    then: ["it is named", (reason, t) => { try { expect(reason).toMatch(/subagent or background job wrote 120s ago/u); } finally { t.cleanup(); } }],
  });
  unit("a silent gate that still holds its output is running", {
    given: ["a background job started 20 minutes ago, quiet for 10", () => { const t = sessionTree(); t.touch(join(t.tasks, "b1.output"), 10 * MIN); return t; }],
    when: ["reading activity", t => t.activity(() => [NOW - 20 * MIN])],
    then: ["it is named", (reason, t) => { try { expect(reason).toBe("a background job has run for 20 min"); } finally { t.cleanup(); } }],
  });
  unit("a job that has held its output for 17 hours is hung, not work", {
    given: ["rg without a path, waiting on stdin since yesterday", () => { const t = sessionTree(); t.touch(join(t.tasks, "b2.output"), 17 * 60 * MIN); return t; }],
    when: ["reading activity", t => t.activity(() => [NOW - 17 * 60 * MIN])],
    then: ["nothing counts as running", (reason, t) => { try { expect(reason).toBeNull(); } finally { t.cleanup(); } }],
  });
  unit("finished subagents and jobs are not running", {
    given: ["writes from 20 minutes ago and no holder", () => {
      const t = sessionTree(); t.touch(join(t.subagents, "agent-a.jsonl"), 20 * MIN); t.touch(join(t.tasks, "b1.output"), 20 * MIN); return t; }],
    when: ["reading activity", t => t.activity()],
    then: ["nothing counts as running", (reason, t) => { try { expect(reason).toBeNull(); } finally { t.cleanup(); } }],
  });
  unit("a process holding a task output file is found with its start time", {
    given: ["a fake /proc with one holder and one bystander", () => {
      const t = sessionTree(); const proc = join(t.root, "proc");
      writeFileSync(join(t.tasks, "b1.output"), "");
      mkdirSync(join(proc, "42", "fd"), { recursive: true });
      mkdirSync(join(proc, "43", "fd"), { recursive: true });
      symlinkSync(join(t.tasks, "b1.output"), join(proc, "42", "fd", "1"));
      symlinkSync("/dev/null", join(proc, "43", "fd", "1"));
      // starttime is field 22: 500 ticks = 5 s after boot.
      writeFileSync(join(proc, "42", "stat"), `42 (rg -n x) S ${"0 ".repeat(18)}500 0 0`);
      writeFileSync(join(proc, "stat"), "cpu 1 2 3\nbtime 1760000000\n");
      return { ...t, proc };
    }],
    when: ["listing holders", t => openFileHolderStarts(t.tasks, t.proc)],
    then: ["only the holder, at boot plus 5 s", (starts, t) => { try { expect(starts).toEqual([1_760_000_005_000]); } finally { t.cleanup(); } }],
  });
  unit("the newest compact boundary in the journal tail counts for spacing", {
    when: ["reading a journal with two boundaries", () => latestJournalCompactMs("/s.jsonl", { readTail: () => ({ text: [
      { type: "system", subtype: "compact_boundary", timestamp: "2026-10-11T01:16:53Z" },
      { type: "user", timestamp: "2026-10-11T01:20:00Z" },
      { type: "system", subtype: "compact_boundary", timestamp: "2026-10-11T02:15:51Z" },
    ].map(JSON.stringify).join("\n") }) })],
    then: ["the later one", at => expect(at).toBe(Date.parse("2026-10-11T02:15:51Z"))],
  });
});

// A fake /proc: field 22 of stat is the start in 1/100 s after boot (btime 1760000000).
function fakeProc(root, procs) {
  const proc = join(root, "proc");
  mkdirSync(proc, { recursive: true });
  writeFileSync(join(proc, "stat"), "cpu 1\nbtime 1760000000\n");
  for (const { pid, ppid, startSec, args, cwd } of procs) {
    mkdirSync(join(proc, String(pid)), { recursive: true });
    writeFileSync(join(proc, String(pid), "stat"), `${pid} (x) S ${ppid} ${"0 ".repeat(17)}${startSec * 100} 0`);
    writeFileSync(join(proc, String(pid), "cmdline"), args.join("\0"));
    if (cwd) symlinkSync(cwd, join(proc, String(pid), "cwd"));
  }
  return proc;
}
const CODEX = "/usr/lib/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex";

feature("what a Codex pane still has running", () => {
  unit("a terminal process is found, the pane's helpers are not", {
    given: ["lsrc:4's Codex with its MCP server, code-mode host and one build started later", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-codex-proc-"));
      const proc = fakeProc(root, [
        { pid: 10, ppid: 1, startSec: 1000, args: [CODEX, "resume", "s4"], cwd: "/lsrc/.agents/4" },
        { pid: 11, ppid: 10, startSec: 1002, args: ["/init", "uvx.exe", "windows-mcp", "serve"] },
        { pid: 12, ppid: 10, startSec: 5000, args: [`${CODEX}-code-mode-host`] },
        { pid: 13, ppid: 10, startSec: 6000, args: ["/bin/bash", "-lc", "npm test"] },
        { pid: 14, ppid: 13, startSec: 6001, args: ["node", "vitest"] },
        { pid: 20, ppid: 1, startSec: 1000, args: [CODEX, "resume", "s5"], cwd: "/lsrc/.agents/5" },
        { pid: 21, ppid: 20, startSec: 6000, args: ["/bin/bash", "-lc", "sleep 9"] },
      ]);
      return { root, proc };
    }],
    when: ["listing lsrc:4's terminals", ({ proc }) => codexTerminalStarts("/lsrc/.agents/4", proc)],
    then: ["the build and its child, not lsrc:5's", (starts, { root }) => {
      try { expect(starts).toEqual([1_760_006_000_000, 1_760_006_001_000]); } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });
  unit("a running terminal holds the compact, a hung one does not", {
    when: ["deciding with a 20-minute and a 17-hour terminal", () => ["fresh", "hung"].map(kind => codexBackgroundActivity({
      sessionPath: "/nowhere/sessions/2026/10/11/rollout-s4.jsonl", sessionId: "s4", paneDir: "/lsrc/.agents/4", now: NOW,
      terminalStarts: () => [NOW - (kind === "fresh" ? 20 : 17 * 60) * MIN] }))],
    then: ["only the fresh one counts", ([fresh, hung]) => {
      expect(fresh).toBe("1 Codex terminal process(es) running, the oldest for 20 min");
      expect(hung).toBeNull();
    }],
  });
  unit("a spawn_agent child that wrote recently holds the compact", {
    given: ["lsrc:3's sessions dir with a fresh child and an unrelated rollout", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-codex-sub-"));
      const day = join(root, "sessions", ...new Date(NOW).toISOString().slice(0, 10).split("-"));
      mkdirSync(day, { recursive: true });
      const parent = join(day, "rollout-parent.jsonl");
      writeFileSync(parent, "");
      const meta = (id, parentId) => JSON.stringify({ type: "session_meta", payload: { id,
        source: { subagent: { thread_spawn: { parent_thread_id: parentId } } } } }) + "\n";
      const child = join(day, "rollout-child.jsonl");
      writeFileSync(child, meta("c1", "p3"));
      writeFileSync(join(day, "rollout-other.jsonl"), meta("o1", "someone-else"));
      const t = new Date(NOW - 30_000);
      utimesSync(child, t, t); utimesSync(join(day, "rollout-other.jsonl"), t, t);
      return { root, parent };
    }],
    when: ["reading lsrc:3's activity", ({ parent }) => codexBackgroundActivity({ sessionPath: parent, sessionId: "p3",
      paneDir: "/lsrc/.agents/3", now: NOW, terminalStarts: () => [] })],
    then: ["the child is named", (reason, { root }) => {
      try { expect(reason).toBe("a Codex subagent wrote 30s ago"); } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });
  unit("Codex's own compact counts for spacing", {
    when: ["reading a Codex journal tail", () => latestJournalCompactMs("/r.jsonl", { readTail: () => ({ text: [
      { type: "compacted", timestamp: "2026-10-11T02:00:00Z", payload: {} },
      { type: "event_msg", timestamp: "2026-10-11T02:00:01Z", payload: { type: "context_compacted" } },
    ].map(JSON.stringify).join("\n") }) })],
    then: ["the latest marker", at => expect(at).toBe(Date.parse("2026-10-11T02:00:01Z"))],
  });
});
