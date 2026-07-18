import { feature, unit, expect } from "bdd-vitest";
import { waitForProgressingUi } from "./progressing-ui.mjs";

feature("progress-aware TUI readiness", () => {
  unit("allows a progressing replay to outlive the old twenty-second cutoff", {
    given: ["a replay that paints until its composer appears after 25 seconds", () => ({ clock: 0 })],
    when: ["readiness is observed", async (ctx) => ({
      ready: await waitForProgressingUi({
        capture: async () => ctx.clock >= 25_000 ? "ready" : `replay-${ctx.clock}`,
        inspect: (screen) => screen === "ready",
        delay: async (ms) => { ctx.clock += ms; },
        now: () => ctx.clock,
        hardTimeoutMs: 60_000,
        stallTimeoutMs: 1_000,
      }),
      clock: ctx.clock,
    })],
    then: ["the progressing replay reaches ready", ({ ready, clock }) => {
      expect(ready).toBe(true);
      expect(clock).toBeGreaterThanOrEqual(25_000);
    }],
  });

  unit("stops a static compositor at the stall boundary", {
    given: ["a frozen screen", () => ({ clock: 0 })],
    when: ["readiness is observed", async (ctx) => ({
      ready: await waitForProgressingUi({
        capture: async () => "frozen",
        inspect: () => false,
        delay: async (ms) => { ctx.clock += ms; },
        now: () => ctx.clock,
        hardTimeoutMs: 60_000,
        stallTimeoutMs: 1_000,
      }),
      clock: ctx.clock,
    })],
    then: ["the waiter fails before the hard timeout", ({ ready, clock }) => {
      expect(ready).toBe(false);
      expect(clock).toBeGreaterThanOrEqual(1_000);
      expect(clock).toBeLessThan(60_000);
    }],
  });
});
