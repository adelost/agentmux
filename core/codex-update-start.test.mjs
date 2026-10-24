import { describe, it, expect } from "vitest";
import { findBlockingPrompt } from "./dismiss.mjs";
import { waitForCodexUiReady } from "./codex-readiness.mjs";

// Actual skyvw:3 frame, lsrc:0 journal 2026-10-24T06:54:56.778Z.
const screen = selected => [
  "  Update available · 0.163.0 → 0.164.0",
  "  Release notes: https://github.com/openai/codex/releases/latest",
  `${selected === 1 ? "›" : " "} 1. Update now (runs \u0060npm install -g @openai/codex\u0060)`,
  `${selected === 2 ? "›" : " "} 2. Skip`,
  `${selected === 3 ? "›" : " "} 3. Skip until next version`,
  "  enter continue · esc skip",
].join("\n");

describe("the installed Codex update-choice startup frame", () => {
  for (const selected of [1,2,3]) it(`skips safely with option ${selected} selected`, () => {
    expect(findBlockingPrompt(screen(selected))).toMatchObject({ name: "codex-update", keys: "Escape" });
  });
  it("passes the real startup readiness path without upgrade keys or a prompt", async () => {
    let frame = screen(1), clock = 0; const keys = [];
    const ready = await waitForCodexUiReady({
      tmux: { captureScreen: async () => frame,
        sendKeys: async (_target,key) => { keys.push(key); frame = key === "Escape" ? "› Ask Codex to do anything" : frame; },
        sendLiteral: async () => { throw Error("startup cannot type a prompt"); } },
      target: "skyvw:.3", agentName: "skyvw", pane: 3, hardTimeoutMs: 3000,
      delay: async ms => { clock += ms; }, now: () => clock, logger: { warn: () => {} },
    });
    expect(ready).toBe(true); expect(keys).toEqual(["Escape"]);
  });
  it("never acts on stale update text or an unknown menu", () => {
    expect(findBlockingPrompt(screen(1) + "\n› A human draft")).toBeNull();
    expect(findBlockingPrompt(screen(1).replace("2. Skip", "2. Buy credits"))).toBeNull();
    expect(findBlockingPrompt(screen(1).replace("enter continue · esc skip", "enter confirm · esc quit"))).toBeNull();
  });
});
