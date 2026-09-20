import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { compactThenSwitchCodex } from "./codex-model-switch.mjs";

feature("compact-first Codex model switching", () => {
  unit("switches only after a newer compact receipt appears", {
    given: ["an idle pane whose next context reading contains a fresh compact marker", () => {
      let now = 0;
      const contexts = [
        { tokens: 90_000, lastCompactAt: "2026-09-20T10:00:00.000Z" },
        { tokens: 12_000, lastCompactAt: "2026-09-20T13:30:00.000Z" },
      ];
      const events = [];
      return {
        now: () => now,
        wait: async () => { now += 100; },
        readContext: vi.fn(async () => contexts.shift() || contexts.at(-1)),
        readOutput: vi.fn(async () => "ready"),
        sendCompact: vi.fn(async () => { events.push("compact"); return { delivered: true }; }),
        switchModel: vi.fn(async () => { events.push("switch"); return { model: "gpt-5.6-sol" }; }),
        events,
      };
    }],
    when: ["running the guarded switch", (deps) => compactThenSwitchCodex({ ...deps, timeoutMs: 1_000, pollMs: 100 })],
    then: ["compact is proven before the switch callback runs", (result, deps) => {
      expect(result).toMatchObject({ ok: true, model: "gpt-5.6-sol" });
      expect(deps.events).toEqual(["compact", "switch"]);
    }],
  });

  unit("a remote compact error stops before model restart", {
    given: ["a pane whose compact command returns an auth error", () => {
      let now = 0;
      const outputs = [
        "ready",
        "Error running remote compact task: access token could not be refreshed",
      ];
      return {
        now: () => now,
        wait: async () => { now += 100; },
        readContext: vi.fn(async () => ({ tokens: 90_000, lastCompactAt: null })),
        readOutput: vi.fn(async () => outputs.shift() || outputs.at(-1)),
        sendCompact: vi.fn(async () => ({ delivered: true })),
        switchModel: vi.fn(async () => ({ model: "gpt-5.6-sol" })),
      };
    }],
    when: ["running the guarded switch", (deps) => compactThenSwitchCodex({ ...deps, timeoutMs: 1_000, pollMs: 100 })],
    then: ["the error is explicit and the model remains untouched", (result, deps) => {
      expect(result).toMatchObject({ ok: false, stage: "compact", reason: "remote-error" });
      expect(deps.switchModel).not.toHaveBeenCalled();
    }],
  });
});
