import { expect, feature, unit } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAUSE_COMPACT_POLICY } from "../policies/context-cost.mjs";
import { latestJournalCompactMs, leaderPanes, openFileHolderStarts, pauseCompactDecision, pauseCompactLimit,
  readPauseCompactMode, sessionBackgroundActivity } from "./pause-compact.mjs";

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
  unit("Codex panes are left out", {
    when: ["a Codex pane is over budget at a pause", () => decide({ engine: "codex" })],
    then: ["nothing happens", result => expect(result).toMatchObject({ action: "none", cell: "not-claude" })],
  });
  unit("a leader keeps 700k", {
    given: ["skyvw orchestrated by pane 0, lsrc led by Codex pane 3 and Claude pane 0", () => ({
      skyvw: { name: "skyvw", orchestrator: 0, leaders: [] }, lsrc: { name: "lsrc", orchestrator: 3, leaders: [0] } })],
    when: ["reading the budgets", ({ skyvw, lsrc }) => ({ skyvw0: pauseCompactLimit(skyvw, 0), skyvw1: pauseCompactLimit(skyvw, 1),
      lsrc0: pauseCompactLimit(lsrc, 0), lsrc2: pauseCompactLimit(lsrc, 2), lsrcLeaders: [...leaderPanes(lsrc)] })],
    then: ["leaders get 700k, builders 400k", budgets => expect(budgets).toEqual({ skyvw0: 700_000, skyvw1: 400_000,
      lsrc0: 700_000, lsrc2: 400_000, lsrcLeaders: [3, 0] })],
  });
  unit("an unknown rollout mode fails loudly and the default is dry", {
    when: ["reading modes", () => ({ unset: readPauseCompactMode({}), bad: () => readPauseCompactMode({ AUTO_COMPACT_PAUSE: "yes" }) })],
    then: ["dry by default, a typo is refused", ({ unset, bad }) => { expect(unset).toBe("dry"); expect(bad).toThrow("AUTO_COMPACT_PAUSE"); }],
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
