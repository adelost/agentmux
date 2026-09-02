import { feature, unit, expect } from "bdd-vitest";
import { blockedByNonEmptyComposer, codexDeliveryBlocked } from "./codex-delivery-blocked.mjs";

feature("Codex delivery-blocked errors", () => {
  unit("the error carries the broker's code and only an explicit recovery flag", {
    when: ["building one plain and one zoom-recoverable error", () => [
      codexDeliveryBlocked("Codex prompt delivery blocked: x"),
      codexDeliveryBlocked("Codex prompt delivery blocked: y", { zoomRecoverable: true }),
    ]],
    then: ["both are Errors with the code; only the second is zoom-recoverable", ([plain, zoom]) => {
      expect(plain).toBeInstanceOf(Error);
      expect(plain.code).toBe("AMUX_DELIVERY_BLOCKED");
      expect(plain.zoomRecoverable).toBeUndefined();
      expect(zoom.code).toBe("AMUX_DELIVERY_BLOCKED");
      expect(zoom.zoomRecoverable).toBe(true);
    }],
  });

  unit("a foreign draft names the drift when the installed Codex is unverified", {
    when: ["building the error with a drifting probe", () => blockedByNonEmptyComposer(
      { codexVocabularyDrift: async () => "Codex 0.153.0 is installed but the composer vocabulary was verified for 0.152.1 (all 6 strings still present)" },
      "Ask Codex to build anything",
      { head: "composer contains a different draft" },
    )],
    then: ["the message keeps the draft head, adds the drift, and stays zoom-recoverable", (error) => {
      expect(error.code).toBe("AMUX_DELIVERY_BLOCKED");
      expect(error.zoomRecoverable).toBe(true);
      expect(error.message).toBe(
        "Codex prompt delivery blocked: composer contains a different draft (starts with: Ask Codex to build anything); "
        + "Codex 0.153.0 is installed but the composer vocabulary was verified for 0.152.1 (all 6 strings still present); "
        + "an unrecognised empty-composer placeholder is the likely cause, see amux doctor",
      );
    }],
  });

  unit("a foreign draft on the verified Codex is reported as a draft, nothing more", {
    when: ["building the error with a silent probe", () => blockedByNonEmptyComposer(
      { codexVocabularyDrift: async () => null }, "deploy everything",
    )],
    then: ["the message is the plain refusal", (error) => {
      expect(error.message).toBe("Codex prompt delivery blocked: composer is not empty (starts with: deploy everything)");
    }],
  });
});
