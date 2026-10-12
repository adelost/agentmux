import { feature, unit, expect } from "bdd-vitest";
import { selectCodexStart } from "./codex-start-selection.mjs";

feature("explicit fresh Codex startup does not mutate historical sessions", () => {
  for (const fresh of [true, false]) {
    unit(`new-session=${fresh} has an explicit startup decision`, {
      when: ["selecting startup with an owned old Astra session", () => selectCodexStart({ dir: "/pane", profile: { home: "/home/one" }, owner: "skydive:4@1",
        remembered: { sessionId: "old" }, launch: { newSession: fresh }, discover: () => ({ path: "/old.jsonl", sessionId: "old" }), writers: () => [] })],
      then: ["only explicit new-session starts fresh, ordinary wake preserves the old identity", result => {
        expect(result.decision.action).toBe(fresh ? "fresh" : "resume");
        expect(result.decision.sessionId).toBe(fresh ? null : "old");
        expect(result.discovered.path).toBe("/old.jsonl");
      }],
    });
  }
});
