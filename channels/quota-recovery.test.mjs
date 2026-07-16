import { feature, component, unit, expect } from "bdd-vitest";
import { createQuotaRecoveryLoop, parseQuotaRecoveryConfig } from "./quota-recovery.mjs";

feature("quota recovery timer", () => {
  component("startup fires immediately and keeps one interval", {
    given: ["an injected coordinator and timer", () => {
      const calls = [];
      const intervals = [];
      const loop = createQuotaRecoveryLoop({
        coordinator: { tick: async () => { calls.push("tick"); return []; } },
        config: { enabled: true, pollMs: 30_000, resetGraceMs: 15_000 },
        setIntervalImpl: (callback, ms) => {
          const handle = { callback, ms, unref: () => {} };
          intervals.push(handle);
          return handle;
        },
        clearIntervalImpl: () => {},
        log: () => {},
      });
      return { calls, intervals, loop };
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
      expect(defaults).toEqual({ enabled: true, pollMs: 30_000, resetGraceMs: 15_000 });
      expect(custom).toEqual({ enabled: false, pollMs: 5_000, resetGraceMs: 30_000 });
    }],
  });
});
