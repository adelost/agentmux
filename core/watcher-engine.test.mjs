import { feature, unit, expect } from "bdd-vitest";
import {
  applyPostFailure,
  applyPostSuccess,
  planPaneMirrorStep,
} from "./watcher-engine.mjs";

const ts = (s) => `2026-05-30T12:00:${s}.000Z`;
const ms = (iso) => new Date(iso).getTime();

function turn({ user = "prompt", at = ts("00"), end = ts("01"), items = ["reply"], complete = true } = {}) {
  return {
    timestamp: at,
    endTimestamp: end,
    userPrompt: user,
    isComplete: complete,
    items: items.map((content) => ({ type: "text", content })),
  };
}

feature("watcher engine: checkpoint and post planning", () => {
  unit("first-time channel seeds to newest turn and does not backpost history", {
    given: ["two historical turns and no checkpoint", () => ({
      turns: [
        turn({ at: ts("00"), end: ts("01") }),
        turn({ at: ts("02"), end: ts("03") }),
      ],
    })],
    when: ["planning", ({ turns }) => planPaneMirrorStep({ turns, lastPostedMs: null })],
    then: ["no post action and checkpoint seeded to newest turn", (r) => {
      expect(r.actions).toEqual([]);
      expect(r.nextState.lastPostedMs).toBe(ms(ts("03")));
      expect(r.notes.some((n) => n.type === "seed")).toBe(true);
    }],
  });

  unit("complete turn after checkpoint produces a postTurn action", {
    given: ["a complete turn after the checkpoint", () => ({
      turns: [turn({ at: ts("10"), end: ts("11"), items: ["hello", "world"] })],
    })],
    when: ["planning", ({ turns }) => planPaneMirrorStep({
      turns,
      lastPostedMs: ms(ts("09")),
      nowMs: ms(ts("20")),
    })],
    then: ["postTurn action includes all new items", (r) => {
      expect(r.actions).toHaveLength(1);
      expect(r.actions[0]).toMatchObject({
        type: "postTurn",
        endMs: ms(ts("11")),
        turnStartMs: ms(ts("10")),
        postedCount: 0,
        totalItems: 2,
        reason: "stop_reason",
      });
      expect(r.actions[0].turn.items.map((i) => i.content)).toEqual(["hello", "world"]);
    }],
  });

  unit("already-posted turn is skipped", {
    given: ["a turn at the checkpoint", () => ({
      turns: [turn({ at: ts("10"), end: ts("11") })],
    })],
    when: ["planning", ({ turns }) => planPaneMirrorStep({ turns, lastPostedMs: ms(ts("11")) })],
    then: ["no actions", (r) => expect(r.actions).toEqual([])],
  });

  unit("partial post plans only new items", {
    given: ["a turn where one item was already posted", () => ({
      turns: [turn({ at: ts("10"), end: ts("11"), items: ["old tool", "final text"] })],
      postedItemCounts: { [String(ms(ts("10")))]: 1 },
    })],
    when: ["planning", ({ turns, postedItemCounts }) => planPaneMirrorStep({
      turns,
      lastPostedMs: ms(ts("10")) - 1,
      postedItemCounts,
      nowMs: ms(ts("20")),
    })],
    then: ["only the final item is planned", (r) => {
      expect(r.actions).toHaveLength(1);
      expect(r.actions[0].postedCount).toBe(1);
      expect(r.actions[0].turn.items.map((i) => i.content)).toEqual(["final text"]);
    }],
  });

  unit("complete turn with no new items advances checkpoint without posting", {
    given: ["a complete turn whose only item is already posted", () => ({
      turns: [turn({ at: ts("10"), end: ts("11"), items: ["already"] })],
      postedItemCounts: { [String(ms(ts("10")))]: 1 },
    })],
    when: ["planning", ({ turns, postedItemCounts }) => planPaneMirrorStep({
      turns,
      lastPostedMs: ms(ts("10")) - 1,
      postedItemCounts,
      nowMs: ms(ts("20")),
    })],
    then: ["checkpoint advances with no post action", (r) => {
      expect(r.actions).toEqual([]);
      expect(r.nextState.lastPostedMs).toBe(ms(ts("11")));
      expect(r.notes.some((n) => n.type === "advance-empty")).toBe(true);
    }],
  });
});

feature("watcher engine: grace and retry policy", () => {
  unit("incomplete turn is held while jsonl mtime is fresh", {
    given: ["an incomplete turn with fresh file mtime", () => {
      const endMs = ms(ts("11"));
      return {
        endMs,
        turns: [turn({ at: ts("10"), end: ts("11"), complete: false })],
      };
    }],
    when: ["planning", ({ turns, endMs }) => planPaneMirrorStep({
      turns,
      lastPostedMs: ms(ts("09")),
      nowMs: endMs + 10_000,
      latestMtimeMs: endMs + 9_900,
      completionGraceMs: 5_000,
    })],
    then: ["no actions", (r) => expect(r.actions).toEqual([])],
  });

  unit("incomplete turn is posted by grace when content and mtime are stable", {
    given: ["an incomplete turn whose content and mtime are old enough", () => {
      const endMs = ms(ts("11"));
      return {
        endMs,
        turns: [turn({ at: ts("10"), end: ts("11"), complete: false, items: ["stable partial"] })],
      };
    }],
    when: ["planning", ({ turns, endMs }) => planPaneMirrorStep({
      turns,
      lastPostedMs: ms(ts("09")),
      nowMs: endMs + 10_000,
      latestMtimeMs: endMs + 5_000,
      completionGraceMs: 5_000,
    })],
    then: ["one grace action", (r) => {
      expect(r.actions).toHaveLength(1);
      expect(r.actions[0].reason).toBe("grace");
    }],
  });

  unit("retryUntil suppresses planning until backoff expires", {
    given: ["a retry window in the future", () => ({
      turns: [turn({ at: ts("10"), end: ts("11") })],
      nowMs: ms(ts("20")),
    })],
    when: ["planning", ({ turns, nowMs }) => planPaneMirrorStep({
      turns,
      lastPostedMs: ms(ts("09")),
      nowMs,
      retryUntilMs: nowMs + 5_000,
    })],
    then: ["no action and retry-wait note", (r, { nowMs }) => {
      expect(r.actions).toEqual([]);
      expect(r.notes[0]).toMatchObject({ type: "retry-wait", untilMs: nowMs + 5_000 });
    }],
  });

  unit("post success advances checkpoint and clears retry", {
    given: ["current state and a successful post action", () => ({
      state: {
        lastPostedMs: ms(ts("09")),
        postedItemCounts: {},
        retryUntilMs: ms(ts("30")),
      },
      action: {
        endMs: ms(ts("11")),
        turnStartMs: ms(ts("10")),
        totalItems: 2,
      },
    })],
    when: ["applying success", ({ state, action }) => applyPostSuccess(state, action)],
    then: ["checkpoint advances, retry clears, posted count records", (next) => {
      expect(next.lastPostedMs).toBe(ms(ts("11")));
      expect(next.retryUntilMs).toBe(null);
      expect(next.postedItemCounts[String(ms(ts("10")))]).toBe(2);
    }],
  });

  unit("post failure does not advance checkpoint and sets retry state", {
    given: ["current state and a failed post action", () => ({
      state: {
        lastPostedMs: ms(ts("09")),
        postedItemCounts: {},
      },
      action: {
        endMs: ms(ts("11")),
        turnStartMs: ms(ts("10")),
        totalItems: 2,
      },
    })],
    when: ["applying failure", ({ state, action }) => applyPostFailure(
      state,
      action,
      { nowMs: ms(ts("20")), retryBackoffMs: 30_000 },
    )],
    then: ["checkpoint stays put and retry is scheduled", (next) => {
      expect(next.lastPostedMs).toBe(ms(ts("09")));
      expect(next.retryUntilMs).toBe(ms(ts("20")) + 30_000);
      expect(next.lastFailedPost).toMatchObject({ endMs: ms(ts("11")), turnStartMs: ms(ts("10")) });
    }],
  });
});
