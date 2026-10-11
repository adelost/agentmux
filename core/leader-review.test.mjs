import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEADER_REVIEW_TEXT, createLeaderReview, leaderReviewDue } from "./leader-review.mjs";
import { createDeliveryMemoryContext } from "./delivery-memory-context.mjs";

const T0 = Date.parse("2026-10-11T05:00:00Z");
const MIN = 60_000;
// skyvw:0 and lsrc:0 lead, as does Codex lsrc:3; lsrc:1 builds.
const LEADERS = new Set(["skyvw:0", "lsrc:0", "lsrc:3"]);
const isLeader = (name, pane) => LEADERS.has(`${name}:${pane}`);

function review(mode = "on") {
  const dir = mkdtempSync(join(tmpdir(), "amux-leader-review-"));
  let now = T0;
  const lines = [];
  const leaderReview = createLeaderReview({ isLeader, mode, now: () => now, statePath: join(dir, "state.json"), record: line => lines.push(line) });
  return { leaderReview, lines, at: minutes => { now = T0 + minutes * MIN; }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

feature("the leader's hourly review", () => {
  unit("the review closes the loop on the last review's change", {
    when: ["reading the review text", () => LEADER_REVIEW_TEXT],
    then: ["it asks whether that change helped, with a verdict and its evidence", text =>
      expect(text).toContain("whether the last review's change helped: keep, adjust or drop, with its evidence")],
  });
  unit("a builder never gets it", {
    when: ["deciding for lsrc:1 two hours after anything", () => leaderReviewDue({ leader: false, lastAtMs: T0, nowMs: T0 + 120 * MIN })],
    then: ["not due", decision => expect(decision.due).toBe(false)],
  });
  component("an orchestrator gets it on its first turn after 60 minutes", {
    given: ["skyvw:0, first seen at 05:00", () => review()],
    when: ["turns at 05:00, 05:59 and 06:00", ctx => {
      const texts = [ctx.leaderReview.take("skyvw:0", "claude-hook")];
      ctx.at(59); texts.push(ctx.leaderReview.take("skyvw:0", "claude-hook"));
      ctx.at(60); texts.push(ctx.leaderReview.take("skyvw:0", "claude-hook"));
      ctx.at(61); texts.push(ctx.leaderReview.take("skyvw:0", "claude-hook"));
      return texts;
    }],
    then: ["only the 06:00 turn carries the review", (texts, ctx) => {
      try {
        expect(texts).toEqual([null, null, LEADER_REVIEW_TEXT, null]);
        expect(ctx.lines.map(line => line.outcome)).toEqual(["clock-started", "added"]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a dry run adds nothing and logs the hourly cadence", {
    given: ["dry mode for lsrc:3", () => review("dry")],
    when: ["turns at 05:00, 06:00 and 06:30", ctx => {
      const texts = [ctx.leaderReview.take("lsrc:3", "delivery")];
      ctx.at(60); texts.push(ctx.leaderReview.take("lsrc:3", "delivery"));
      ctx.at(90); texts.push(ctx.leaderReview.take("lsrc:3", "delivery"));
      return texts;
    }],
    then: ["no text, one would-add at 06:00", (texts, ctx) => {
      try {
        expect(texts).toEqual([null, null, null]);
        expect(ctx.lines.map(line => `${line.at.slice(11, 16)} ${line.outcome}`)).toEqual(["05:00 clock-started", "06:00 would-add"]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("it rides on a real Codex delivery and never creates one", {
    given: ["Codex lsrc:3 due for its review, and a queue that records what it is asked", () => {
      const ctx = review();
      ctx.leaderReview.take("lsrc:3", "delivery");
      ctx.at(61);
      const calls = [];
      const queue = { update: (job, patch) => { calls.push("update"); return { ...job, ...patch }; },
        enqueue: () => { calls.push("enqueue"); } };
      const agent = { memorySnapshot: () => ({ engine: "codex", sessionId: "s3", sessionPath: "/s3.jsonl",
        context: { version: "a".repeat(64), workspace: "/w" } }) };
      const stateDir = mkdtempSync(join(tmpdir(), "amux-memory-"));
      const memory = createDeliveryMemoryContext({ agent, queue, now: () => T0 + 61 * MIN, stateDir, leaderReview: ctx.leaderReview });
      return { ...ctx, calls, memory, stateDir };
    }],
    when: ["Mattias's next prompt reaches lsrc:3", ctx => ctx.memory.prepare({ id: "j1", kind: "prompt", status: "pending",
      agentName: "lsrc", pane: 3, text: "Kör nästa steg i G3.", verifyText: "Kör nästa steg i G3." })],
    then: ["the prompt carries the review, the ask stays exact, nothing else is queued", (job, ctx) => {
      try {
        expect(job.text.startsWith("Kör nästa steg i G3.\n\n")).toBe(true);
        expect(job.text.endsWith(LEADER_REVIEW_TEXT)).toBe(true);
        expect(job.verifyText).toBe("Kör nästa steg i G3.");
        expect(job.metadata.memoryContext.hinted).toBe(true);
        expect(ctx.calls).toEqual(["update"]);
      } finally { ctx.cleanup(); rmSync(ctx.stateDir, { recursive: true, force: true }); }
    }],
  });
});
