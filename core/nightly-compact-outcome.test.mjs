import { feature, unit, expect } from "bdd-vitest";
import { nightlyCompactOutcome } from "./nightly-compact.mjs";

const before = { sessionId: "s1", sessionPath: "/s1.jsonl", tokens: 4_000 };

feature("compact outcome when Claude has nothing to compact", () => {
  unit("Not enough messages to compact is its own outcome, not a failed compact", {
    when: ["the receipt says nothing to compact for the same session", () =>
      nightlyCompactOutcome({ ok: false, reason: "compact-nothing-to-compact", nothingToCompact: true, sessionId: "s1" },
        before, { ...before }, 80_000)],
    then: ["the pane may proceed: no boundary is owed", (outcome) => {
      expect(outcome).toEqual({ status: "nothing-to-compact", afterTokens: 4_000 });
    }],
  });

  unit("a nothing-to-compact answer from another session stays a failure", {
    when: ["the session changed in between", () =>
      nightlyCompactOutcome({ ok: false, reason: "compact-nothing-to-compact", nothingToCompact: true, sessionId: "s0" },
        before, { ...before }, 80_000)],
    then: ["it is not taken as proof", (outcome) => {
      expect(outcome.status).toBe("failed");
    }],
  });
});
