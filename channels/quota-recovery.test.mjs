import { feature, component, unit, expect } from "bdd-vitest";
import { createQuotaRecoveryLoop, parseQuotaRecoveryConfig } from "./quota-recovery.mjs";

feature("quota recovery timer", () => {
  component("startup fires immediately and keeps one interval", {
    given: ["an injected coordinator and timer", () => {
      const calls = [];
      const intervals = [];
      const heartbeats = [];
      const loop = createQuotaRecoveryLoop({
        coordinator: { tick: async () => { calls.push("tick"); return []; } },
        config: { enabled: true, pollMs: 30_000, resetGraceMs: 15_000, stallMs: 60_000 },
        setIntervalImpl: (callback, ms) => {
          const handle = { callback, ms, unref: () => {} };
          intervals.push(handle);
          return handle;
        },
        clearIntervalImpl: () => {},
        heartbeat: (beat) => heartbeats.push(beat),
        log: () => {},
      });
      return { calls, heartbeats, intervals, loop };
    }],
    when: ["start is called twice", async ({ loop }) => {
      loop.start();
      loop.start();
      await Promise.resolve();
    }],
    then: ["one immediate poll and one timer exist", (_, ctx) => {
      expect(ctx.calls).toEqual(["tick"]);
      expect(ctx.intervals).toHaveLength(1);
      expect(ctx.intervals[0].ms).toBe(30_000);
      expect(ctx.heartbeats.map((beat) => beat.state)).toEqual(["running", "ok"]);
    }],
  });

  unit("the automatic guard is enabled by default and tunable", {
    when: ["parsing default and explicit environments", () => ({
      defaults: parseQuotaRecoveryConfig({}),
      custom: parseQuotaRecoveryConfig({
        AMUX_QUOTA_RECOVERY_ENABLED: "false",
        AMUX_QUOTA_RECOVERY_POLL_MS: "5000",
        AMUX_QUOTA_RECOVERY_RESET_GRACE_MS: "30000",
      }),
    })],
    then: ["the kill switch and cadence are stable", ({ defaults, custom }) => {
      expect(defaults).toEqual({
        enabled: true,
        pollMs: 30_000,
        resetGraceMs: 15_000,
        stallMs: 15 * 60_000,
      });
      expect(custom).toEqual({
        enabled: false,
        pollMs: 5_000,
        resetGraceMs: 30_000,
        stallMs: 15 * 60_000,
      });
    }],
  });

  component("a wedged poll fails loud instead of parking recovery forever", {
    given: ["a coordinator whose tick never settles", () => {
      const timers = [];
      const stalls = [];
      const heartbeats = [];
      const loop = createQuotaRecoveryLoop({
        coordinator: { tick: () => new Promise(() => {}) },
        config: { enabled: true, pollMs: 30_000, resetGraceMs: 15_000, stallMs: 900_000 },
        setTimeoutImpl: (callback, ms) => {
          const timer = { callback, ms, unref: () => {} };
          timers.push(timer);
          return timer;
        },
        clearTimeoutImpl: () => {},
        heartbeat: (beat) => heartbeats.push(beat),
        onStall: (message) => stalls.push(message),
        log: () => {},
      });
      return { heartbeats, loop, stalls, timers };
    }],
    when: ["the bounded watchdog expires", async (ctx) => {
      const pending = ctx.loop.tick();
      ctx.timers[0].callback();
      await pending;
    }],
    then: ["the bridge supervisor receives one explicit restart signal", (_, ctx) => {
      expect(ctx.stalls).toEqual(["tick exceeded 900000ms"]);
      expect(ctx.heartbeats.map((beat) => beat.state)).toEqual(["running", "stalled"]);
    }],
  });
});
