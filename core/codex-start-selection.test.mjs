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

// skybar:4, 2026-10-16: the new Sol session had no rollout before a restart,
// so the next wake resumed the replaced Astra session and held the work.
feature("a pane never resumes the session it replaced", () => {
  unit("a replacement without a rollout yet starts another fresh session", {
    when: ["starting the pane after a restart", () => {
      const asked = [];
      const result = selectCodexStart({ dir: "/pane", profile: { home: "/home/one" }, owner: "skybar:4@1",
        remembered: { pane: "skybar:4@1", sessionId: "unwritten", status: "ready", supersededSessionId: "old-astra" }, launch: null,
        discover: (_dir, { accept }) => { asked.push(Boolean(accept)); return !accept || accept({ id: "old-astra" }) ? { path: "/old.jsonl", sessionId: "old-astra" } : null; },
        writers: () => [] });
      return { result, asked };
    }],
    then: ["discovery skips the replaced session and nothing resumes it", ({ result, asked }) => {
      expect(asked).toEqual([true]);
      expect(result.decision).toMatchObject({ action: "fresh", sessionId: null });
    }],
  });
});
