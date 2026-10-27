import { expect, feature, unit } from "bdd-vitest";
import { summarizeClaims, qualifyClaims } from "./claim-corpus.mjs";

feature("only qualified two-day evidence enables a claim hold", () => {
  unit("ungraded, unrelated-sentence and method errors cannot be scored as catches", {
    given: ["one hold and two known error descriptions", () => ({
      rows: [{ id: "original", textSha256: "exact", verdict: "hold", sentences: [{ text: "Different unsupported statement" }] }],
      known: { confirmedAt: "date", confirmationSource: "original", groups: [
        { name: "wrong method", detectable: false, replies: [{ id: "original", claim: "Different" }] },
        { name: "actual error", replies: [{ id: "original", claim: "Missing target statement" }] },
      ] },
    })],
    when: ["summarizing", ({ rows, known }) => summarizeClaims(rows, { known })],
    then: ["no false catch or false-stop number is invented", result => {
      expect(result.caught).toBe(0); expect(result.falseStopRate).toBeNull(); expect(result.reviewComplete).toBe(false);
    }],
  });
  unit("requires independently graded days on the same algorithm", {
    given: ["a passing threshold report", () => ({ day: "2026-10-27", algorithm: "same", knownConfirmed: true,
      errors: Array(7).fill({}), caught: 5, strictCaught: 5, reviewComplete: true, falseStopRate: 0.1, shareHeld: 0.1 })],
    when: ["qualifying held-out variants", today => [
      qualifyClaims(today, { ...today, day: "2026-10-26" }),
      qualifyClaims(today, { ...today }),
      qualifyClaims(today, { ...today, day: "2026-10-26", algorithm: "old" }),
      qualifyClaims(today, { ...today, day: "2026-10-26", falseStopRate: 0.11 }),
      qualifyClaims(today, { ...today, day: "2026-10-26", reviewComplete: false }),
      qualifyClaims({ ...today, strictCaught: 4 }, { ...today, day: "2026-10-26" }),
      qualifyClaims({ ...today, shareHeld: 0.101 }, { ...today, day: "2026-10-26" }),
      qualifyClaims(today, { ...today, day: "2026-10-26", shareHeld: 0.101 }),
    ]],
    then: ["only qualified days with both error variants and bounded hold shares pass", values => expect(values).toEqual([true, false, false, false, false, false, false, false])],
  });
});
