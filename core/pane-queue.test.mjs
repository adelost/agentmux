import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createPaneQueue } from "./pane-queue.mjs";

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

feature("pane queue: coalescing and concurrency", () => {
  unit("100 signals to the same pane while active become one trailing job", {
    given: ["a queue with a gated first job", () => {
      const started = [];
      let releaseFirst;
      const gate = new Promise((resolve) => { releaseFirst = resolve; });
      const q = createPaneQueue({
        worker: async ({ key }) => {
          started.push(key);
          if (started.length === 1) await gate;
        },
        maxConcurrency: 4,
      });
      return { q, started, releaseFirst };
    }],
    when: ["100 more signals arrive while first job is active", async (ctx) => {
      ctx.q.enqueue("claw:2");
      await flush();
      for (let i = 0; i < 100; i++) ctx.q.enqueue("claw:2", { n: i });
      const startedBeforeRelease = [...ctx.started];
      ctx.releaseFirst();
      await ctx.q.onIdle();
      return { ...ctx, startedBeforeRelease };
    }],
    then: ["there was one active job and one trailing re-run", ({ started, startedBeforeRelease }) => {
      expect(startedBeforeRelease).toEqual(["claw:2"]);
      expect(started).toEqual(["claw:2", "claw:2"]);
    }],
  });

  unit("global maxConcurrency is respected across panes", {
    given: ["a queue with maxConcurrency=2 and three pane jobs", () => {
      const running = new Set();
      let maxSeen = 0;
      const releases = [];
      const q = createPaneQueue({
        maxConcurrency: 2,
        worker: async ({ key }) => {
          running.add(key);
          maxSeen = Math.max(maxSeen, running.size);
          await new Promise((resolve) => releases.push(() => {
            running.delete(key);
            resolve();
          }));
        },
      });
      return { q, releases, maxSeen: () => maxSeen };
    }],
    when: ["three jobs are queued", async (ctx) => {
      ctx.q.enqueue("a:0");
      ctx.q.enqueue("a:1");
      ctx.q.enqueue("a:2");
      await flush();
      const queuedWhileTwoActive = ctx.q.stats().queued;
      const maxWhileActive = ctx.maxSeen();
      ctx.releases.splice(0).forEach((r) => r());
      await flush();
      ctx.releases.splice(0).forEach((r) => r());
      await ctx.q.onIdle();
      return { queuedWhileTwoActive, maxWhileActive, maxFinal: ctx.maxSeen() };
    }],
    then: ["only two jobs ran concurrently", (r) => {
      expect(r.maxWhileActive).toBe(2);
      expect(r.queuedWhileTwoActive).toBe(1);
      expect(r.maxFinal).toBe(2);
    }],
  });
});

feature("pane queue: backoff", () => {
  unit("worker-requested retryAfter delays the next job for that pane", {
    given: ["a queue whose worker asks for retryAfterMs", () => {
      let nowMs = 1_000;
      const timers = [];
      const worker = vi.fn(async () => ({ retryAfterMs: 5_000 }));
      const q = createPaneQueue({
        worker,
        now: () => nowMs,
        setTimer: (fn, ms) => {
          timers.push({ fn, ms });
          return timers.length - 1;
        },
        clearTimer: () => {},
      });
      return {
        q,
        worker,
        timers,
        advance: (ms) => { nowMs += ms; },
      };
    }],
    when: ["the same pane is enqueued before backoff expires", async (ctx) => {
      ctx.q.enqueue("claw:2");
      await ctx.q.onIdle();
      const afterFirst = ctx.worker.mock.calls.length;
      const delayed = ctx.q.enqueue("claw:2");
      ctx.advance(5_000);
      ctx.timers[0].fn();
      await ctx.q.onIdle();
      return { afterFirst, delayed, calls: ctx.worker.mock.calls.length, timerMs: ctx.timers[0].ms };
    }],
    then: ["the retry waits for the timer", (r) => {
      expect(r.afterFirst).toBe(1);
      expect(r.delayed.status).toBe("delayed");
      expect(r.timerMs).toBe(5_000);
      expect(r.calls).toBe(2);
    }],
  });

  unit("thrown worker error sets backoff and prevents immediate retry", {
    given: ["a queue whose first worker call throws", () => {
      let nowMs = 10_000;
      const timers = [];
      const worker = vi.fn()
        .mockRejectedValueOnce(new Error("discord down"))
        .mockResolvedValueOnce({});
      const q = createPaneQueue({
        worker,
        backoffMs: 3_000,
        now: () => nowMs,
        setTimer: (fn, ms) => {
          timers.push({ fn, ms });
          return timers.length - 1;
        },
        clearTimer: () => {},
      });
      return {
        q,
        worker,
        timers,
        advance: (ms) => { nowMs += ms; },
      };
    }],
    when: ["the same pane is retried immediately", async (ctx) => {
      ctx.q.enqueue("claw:2");
      await ctx.q.onIdle();
      const afterFirst = ctx.worker.mock.calls.length;
      const delayed = ctx.q.enqueue("claw:2");
      ctx.advance(3_000);
      ctx.timers[0].fn();
      await ctx.q.onIdle();
      return { afterFirst, delayed, calls: ctx.worker.mock.calls.length, timerMs: ctx.timers[0].ms };
    }],
    then: ["retry is delayed by backoff", (r) => {
      expect(r.afterFirst).toBe(1);
      expect(r.delayed.status).toBe("delayed");
      expect(r.timerMs).toBe(3_000);
      expect(r.calls).toBe(2);
    }],
  });
});
