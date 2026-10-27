import { expect, feature, unit } from "bdd-vitest";
import { checkReply } from "./claim-guard.mjs";

feature("only three consequential reply classes require evidence", () => {
  for (const text of [
    "NEXT: dina två nycklar, `ANTHROPIC_KEY_BENCH` och `ANTHROPIC_KEY_CUT`.",
    "Du behöver köra `node setup.mjs`.",
    "NEXT: säg ja, så startar jag inloggningen.",
    "Kan du godkänna släppet?",
    "Tjänsten är live.", "Rättningen är släppt.", "Felet är rättat.",
    "Quick fungerar inte för vanliga användare.",
    "Quick-analysen kan vara trasig för vanliga användare just nu.",
    "A går inte att använda just nu, eftersom den behöver loggas in igen.",
    "Orsaken är att läsaren använder fel version.",
    "Felet beror på att klienten återanvänder en gammal vy.",
  ]) unit(`requires evidence: ${text}`, {
    given: ["an unsupported request, operational state or technical cause", () => text],
    when: ["checking the reply", text => checkReply(text, [])],
    then: ["the consequential sentence is held", result => expect(result.verdict).toBe("hold")],
  });
  for (const text of [
    "Alla 42 tester gick igenom.", "Kvoten är slut.", "Filen finns inte i repot.",
    "Jag hittade ingen färdig versionskontroll i repot.",
    "Koden är sparad i git.", "Jag har skickat meddelandet till ai:1.",
    "NEXT: jag kontrollerar nycklarna.", "Förslag: jag kontrollerar om tjänsten är live.",
    "Om proven håller släpper jag rättningen.", "Är tjänsten live?",
    "Jag väljer att vänta eftersom bilden är svårläst.",
    "Jag undersöker vad felet beror på.", "Orsaken är inte kontrollerad.",
    "Antagande: felet kommer från cachen.", "Inte kontrollerat: tjänsten är live.",
  ]) unit(`passes outside the three classes: ${text}`, {
    given: ["a routine fact, plan, question or explicit uncertainty", () => text],
    when: ["checking the reply", text => checkReply(text, [])],
    then: ["the reply passes", result => expect(result.verdict).toBe("pass")],
  });
  unit("a bare SHA, public URL or the requested command cannot justify the request", {
    given: ["references without explanatory evidence", () => [
      "Du behöver köra `node setup.mjs`, abcdef123.",
      "Du behöver köra `node setup.mjs`, https://example.org/.",
      "Du behöver köra `node setup.mjs`.",
    ]],
    when: ["checking each request", replies => replies.map(text => checkReply(text, { validate: () => true }).verdict)],
    then: ["none is justified", results => expect(results).toEqual(["hold", "hold", "hold"])],
  });
  unit("a dedicated saved receipt covers the reply while an unrelated bullet does not", {
    given: ["one explanatory receipt and one unrelated source", () => [
      "Tjänsten är live.\nKvitto: `/tmp/.artifacts/release/receipt.json`.",
      "Tjänsten är live.\nNEXT: läs https://example.org/status.",
    ]],
    when: ["checking with a valid receipt", replies => replies.map(text => checkReply(text, { validate: () => true }).verdict)],
    then: ["only the dedicated evidence qualifies", results => expect(results).toEqual(["pass", "hold"])],
  });
});
