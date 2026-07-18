import { feature, unit, expect } from "bdd-vitest";
import { waitForCodexUiReady } from "./codex-readiness.mjs";

feature("Codex startup readiness", () => {
  unit("accepts a replay that progresses for more than twenty seconds", {
    given: ["a slow Codex replay and a fake clock", () => ({ clock: 0, escapes: 0 })],
    when: ["the pane eventually paints an empty composer", async (ctx) => ({
      ready: await waitForCodexUiReady({
        tmux: {
          captureScreen: async () => ctx.clock >= 25_000
            ? "› Find and fix a bug in @filename\n\n  gpt-5.6-sol xhigh · /workspace"
            : `replaying transcript ${ctx.clock}`,
          sendKeys: async () => {},
          sendLiteral: async () => {},
          sendEscape: async () => { ctx.escapes++; },
        },
        target: "claw:.6",
        agentName: "claw",
        pane: 6,
        delay: async (ms) => { ctx.clock += ms; },
        now: () => ctx.clock,
        hardTimeoutMs: 60_000,
      }),
      clock: ctx.clock,
      escapes: ctx.escapes,
    })],
    then: ["readiness succeeds instead of applying the old hard cutoff", ({ ready, clock, escapes }) => {
      expect(ready).toBe(true);
      expect(clock).toBeGreaterThanOrEqual(25_000);
      expect(escapes).toBe(3);
    }],
  });

  unit("accepts a large exact-session replay whose screen stays static for forty-five seconds", {
    given: ["a static replay screen and a fake clock", () => ({ clock: 0 })],
    when: ["the exact session eventually paints its composer", async (ctx) => ({
      ready: await waitForCodexUiReady({
        tmux: {
          captureScreen: async () => ctx.clock >= 45_000
            ? "› Run /review on my current changes\n\n  gpt-5.6-sol xhigh · /workspace"
            : "Resuming session…",
          sendKeys: async () => {},
          sendLiteral: async () => {},
          sendEscape: async () => {},
        },
        target: "ai:.3",
        agentName: "ai",
        pane: 3,
        delay: async (ms) => { ctx.clock += ms; },
        now: () => ctx.clock,
      }),
      clock: ctx.clock,
    })],
    then: ["the old thirty-second false-stall cannot strand the healthy pane", ({ ready, clock }) => {
      expect(ready).toBe(true);
      expect(clock).toBeGreaterThanOrEqual(45_000);
      expect(clock).toBeLessThan(90_000);
    }],
  });
});
