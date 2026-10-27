import { component, expect, feature, unit } from "bdd-vitest";
import { ownerOfTurn } from "./codex-turn-owner.mjs";

// lsrc:0 for api:0, 2026-10-27: Mattias's own turn is never stopped. The journal shows the prompts of a turn, the ask ledger
// shows how each reached the pane; a continuation the account switch typed reads as plain text in the journal.
const ask = (source, verbatim) => ({ pane: 5, source, verbatim });

feature("whose turn it is", () => {
  component("a prompt the ledger knows as the account switch's own is not his, though its text is plain", {
    given: ["the switch's continuation in the ledger", () => ({ prompts: ["Ditt konto byttes. Fortsätt där du var."], asks: [ask("codex-account-switch", "Ditt konto byttes. Fortsätt där du var.")] })],
    when: ["judging", input => ownerOfTurn(input)],
    then: ["not his", owner => expect(owner).toBe(false)],
  });
  unit("a Discord message is his", {
    given: ["a plain prompt the ledger has from Discord", () => ({ prompts: ["Hur går det med Kit?"], asks: [ask("discord", "Hur går det med Kit?")] })],
    when: ["judging", input => ownerOfTurn(input)],
    then: ["his", owner => expect(owner).toBe(true)],
  });
  unit("a plain prompt the ledger does not know was typed into the pane by him", {
    given: ["no ask for it", () => ({ prompts: ["fortsätt"], asks: [] })],
    when: ["judging", input => ownerOfTurn(input)],
    then: ["his", owner => expect(owner).toBe(true)],
  });
  unit("an agent's brief and amux's own notices are not his", {
    given: ["a brief, a pause-compact notice and the guard's continuation, none in the ledger", () => ({ asks: [],
      prompts: ["[from lsrc:0] Från lsrc:0 till claw:5: bygg", "[pause-compact] Your context is 606k", "[AMUX CODEX CREDIT STOP] Your turn was interrupted"] })],
    when: ["judging", input => ownerOfTurn(input)],
    then: ["not his", owner => expect(owner).toBe(false)],
  });
  component("one plain message among agents' briefs makes the turn his", {
    given: ["a turn steered by him", () => ({ prompts: ["[from claw:0] bygg", "Hur går det?"], asks: [ask("discord", "Hur går det?")] })],
    when: ["judging", input => ownerOfTurn(input)],
    then: ["his", owner => expect(owner).toBe(true)],
  });
  unit("without the turn's prompts nobody can say", {
    given: ["a turn whose start left the window, and one with no prompt", () => [{ prompts: null, asks: [] }, { prompts: [], asks: [] }]],
    when: ["judging both", inputs => inputs.map(input => ownerOfTurn(input))],
    then: ["unknown", owners => expect(owners).toEqual([null, null])],
  });
});
