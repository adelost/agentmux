import { expect, feature, unit } from "bdd-vitest";
import { blockedDeliveryNotice } from "./delivery-notices.mjs";

feature("durable delivery notice copy", () => {
  unit("a memory-refused Claude wake is never mislabeled as Codex", {
    when: ["rendering the persisted refusal", () => blockedDeliveryNotice({
      lastReason: "wake-refused:memory-critical",
    })],
    then: ["the real blocker is named without inventing an engine", (notice) => {
      expect(notice).toContain("kritisk minnespress");
      expect(notice).toContain("säkert köat");
      expect(notice).not.toMatch(/Codex|Claude|composer/u);
    }],
  });

  unit("identity and unknown refusals stay honest and actionable", {
    then: ["each reason has bounded engine-neutral copy", () => {
      expect(blockedDeliveryNotice({ lastReason: "wake-refused:identity-package-content" }))
        .toContain("release-identiteten");
      expect(blockedDeliveryNotice({ lastReason: "probe unavailable" }))
        .toContain("inte redo för säker leverans");
    }],
  });
});
