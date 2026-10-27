import { expect, feature, unit } from "bdd-vitest";
import { checkReply } from "./claim-guard.mjs";

feature("completed factual replies require sources", () => {
  for (const text of [
    "A går inte att använda just nu, eftersom den behöver loggas in igen.",
    "Jag hittade ingen färdig versionskontroll i repot.",
    "628 fick sin plats i släppkön efter 541 och 622.",
    "Quick-analysen kan vara trasig för vanliga användare just nu.",
    "Du har nu två nycklar att lägga in.",
    "Alla 42 tester gick igenom.",
  ]) unit(`holds the unsupported fact: ${text}`, {
    given: ["a completed reply with no citation", () => text],
    when: ["checking the reply", text => checkReply(text, [])],
    then: ["it identifies the actual sentence", result => {
      expect(result.verdict).toBe("hold");
      expect(result.sentences[0].text).toBe(text);
    }],
  });
  for (const text of [
    "NEXT: Kontrollera att tjänsten är live.", "Förslag: flytta nyckeln till gatewayn.",
    "Jag ska kontrollera tjänsten.", "Är tjänsten live?", "Antagande: nyckeln saknas.",
    "Inte kontrollerat: tjänsten är live.", "Hej, tack för bilden!",
    "Nästa plats är det nya släppet.", "Om proven håller är släppet klart.",
    "Finns ingen gemensam fil startar raden nu med ett prov.", "Båda sparproven är därför oprövade.",
    "Det räcker därför att deklarera den kopplingen; assertions och produktkod kan vara oförändrade.",
  ]) unit(`does not invent a claim in: ${text}`, {
    given: ["a plan, question or explicit uncertainty", () => text],
    when: ["checking the reply", text => checkReply(text, [])],
    then: ["it passes", result => expect(result.verdict).toBe("pass")],
  });
  unit("a source on the next unrelated bullet cannot cover an assertion", {
    given: ["a quota assertion followed by a plan with a URL", () => "Kvoten är slut.\n- NEXT: läs https://example.org/status"],
    when: ["checking", text => checkReply(text, [])],
    then: ["the quota remains unsupported", result => expect(result.verdict).toBe("hold")],
  });
  unit("quoted commands are data, never executed for source validation", {
    given: ["an assertion citing a command without its output", () => "Testerna är gröna, `touch /tmp/claim-guard-never-run`."],
    when: ["checking", text => checkReply(text, [])],
    then: ["it cannot qualify as evidence", result => expect(result.verdict).toBe("hold")],
  });
  unit("a URL is a source but not proof that the statement is true", {
    given: ["an explicitly sourced assertion", () => "Tjänsten är live: https://example.org/status."],
    when: ["checking", text => checkReply(text, [])],
    then: ["source presence passes", result => expect(result.verdict).toBe("pass")],
  });
});
