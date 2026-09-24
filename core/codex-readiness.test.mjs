import { feature, unit, expect } from "bdd-vitest";
import { waitForCodexUiReady } from "./codex-readiness.mjs";

feature("Codex startup readiness", () => {
  unit("accepts a replay that progresses for more than twenty seconds", {
    given: ["a slow Codex replay and a fake clock", () => ({ clock: 0, escapes: 0 })],
    when: ["the pane eventually paints an empty composer", async (ctx) => ({
      ready: await waitForCodexUiReady({
        tmux: {
          captureScreen: async () => ctx.clock >= 25_000
            ? "› Ask Codex to do anything\n\n  gpt-5.6-sol xhigh · /workspace"
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
            ? "› Ask a follow-up question\n\n  gpt-5.6-sol xhigh · /workspace"
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

  unit("waits for a large resumed session past the former startup cutoff", {
    given: ["a static replay that renders its composer after 130 seconds", () => ({ clock: 0 })],
    when: ["waiting for the exact pane to become usable", async (ctx) => waitForCodexUiReady({
      tmux: {
        captureScreen: async () => ctx.clock >= 130_000
          ? "› Ask Codex to do anything\n  gpt-6-luna medium · /workspace"
          : "Resuming session…",
        sendKeys: async () => {}, sendLiteral: async () => {}, sendEscape: async () => {},
      },
      target: "skyvw:.3", agentName: "skyvw", pane: 3,
      delay: async (ms) => { ctx.clock += ms; }, now: () => ctx.clock,
      logger: { warn: () => {} },
    })],
    then: ["wake does not falsely fail while Codex is still replaying", (ready, ctx) => {
      expect(ready).toBe(true);
      expect(ctx.clock).toBeGreaterThanOrEqual(130_000);
    }],
  });

  unit("dismisses update and paused-goal menus without activating the old goal", {
    given: ["the two startup menus before an empty Luna composer", () => ({
      stage: 0, keys: [], screens: [
        "Update available! 0.155.1 -> 0.156.1\n› 1. Update now\n  2. Skip\nPress enter to continue",
        "Resume paused goal?\nGoal: Old work\n› 1. Resume goal\n  2. Leave paused\nPress enter to confirm or esc to go back",
        "› Ask Codex to do anything\n  gpt-6-luna medium · /workspace",
      ],
    })],
    when: ["waiting for the composer", async ctx => waitForCodexUiReady({
      tmux: {
        captureScreen: async () => ctx.screens[ctx.stage],
        sendKeys: async (_target, keys) => { ctx.keys.push(keys); ctx.stage++; },
        sendLiteral: async () => {}, sendEscape: async () => { throw new Error("unexpected Escape"); },
      },
      target: "skyvw:.4", agentName: "skyvw", pane: 4, delay: async () => {},
    })],
    then: ["startup reaches Luna with both safe choices", (ready, ctx) => {
      expect(ready).toBe(true);
      expect(ctx.keys).toEqual(["Down Enter", "Down Enter"]);
    }],
  });
});
