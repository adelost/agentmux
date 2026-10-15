import { feature, component, expect } from "bdd-vitest";
import { captureDeliveryCursor } from "./delivery-cursor.mjs";

feature("pre-write Codex cursors follow an exact-session account wake", () => {
  for (const fenced of [false, true]) component(`an account clone path changes with submit fence=${fenced}`, {
    given: ["an old account cursor and the running account's verified new cursor", () => {
      const old = { kind: "codex-prompt-events-v1", positions: { "/two/same-thread.jsonl": 240 } };
      const current = { kind: "codex-prompt-events-v1", positions: { "/one/same-thread.jsonl": 260 } };
      return { old, current, job: { kind: "prompt", agentName: "test", pane: 3, verifyText: "Continue", echoCursor: old,
        ...(fenced ? { submitFenceAt: 123 } : {}) },
        queue: { update: (job, patch) => ({ ...job, ...patch }) },
        agent: { capturePromptEchoCursor: async () => current } };
    }],
    when: ["the broker captures after wake but before its first physical write", fx => captureDeliveryCursor({ ...fx, afterWake: true })],
    then: ["only an unsent job follows the new file; submitted evidence is immutable", (job, fx) =>
      expect(job.echoCursor).toEqual(fenced ? fx.old : fx.current)],
  });
});
