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
});
