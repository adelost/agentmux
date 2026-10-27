import { expect, feature, unit } from "bdd-vitest";
import { checkReply, checkTaskNames } from "./claim-guard.mjs";

feature("a first task reference carries a short name in shadow", () => {
  const ids = ["638", "533c", "107", "687", "426"];
  for (const [text, verdict] of [
    ["638 är klar.", "hold"], ["533c är klar.", "hold"],
    ["638 (tydlig prisrad) är klar. 638 väntar på bild.", "pass"],
    ["638, tydlig prisrad, är klar.", "pass"],
    ["638 är klar. 638 (tydlig prisrad) är klar.", "hold"],
    ["638 (pris) är klar.", "hold"], ["638 (en titel med fem ord) är klar.", "hold"],
    ["PR #14 är klar.", "hold"], ["ticket 14 (rätt vy) är klar.", "pass"],
    ["2026-10-27, 09:24Z, 426/687 svar, 107 px, 638 prov, 1.25.370.", "pass"],
    ["`app.js:638` https://example.org/638 `git show 638`", "pass"],
    ["Släpp 638, version 533c, release 107.", "pass"],
  ]) unit(text, {
    given: ["known ledger IDs and visible text", () => text],
    when: ["checking first mentions", text => checkTaskNames(text, ids)],
    then: ["names and measurements are distinguished", result => expect(result.verdict).toBe(verdict)],
  });
  unit("name warnings remain separate from claim enforcement", {
    given: ["an ordinary update with a bare known row", () => "638 är sparad i git."],
    when: ["checking both policies", text => checkReply(text, { validate: () => false, taskNumbers: () => ids })],
    then: ["the ordinary fact passes while its name warning is logged", result => {
      expect(result.verdict).toBe("pass"); expect(result.names.verdict).toBe("hold");
    }],
  });
});
