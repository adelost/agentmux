import { authoredPromptText } from "./system-noise.mjs";
import { inferAskOrigin, isHumanAsk } from "./ask-origin.mjs";

// A prompt is his when the ask ledger got it from a person, or, with no ask for it, when it reads as plain text typed into the pane.
const isHuman = ({ source = "pane-hook", verbatim, sender = null }) => inferAskOrigin({ source, sender, prompt: verbatim }) === "human"
  && isHumanAsk({ source: "pane-hook", verbatim });

/**
 * WHAT: Checks whether a person wrote any prompt of a turn; null when unknown.
 * WHY: Keeps the credit guard from stopping Mattias's own turn.
 */
export function ownerOfTurn({ prompts, asks }) {
  if (!prompts?.length) return null;
  return prompts.some(text => {
    const known = asks.findLast(entry => authoredPromptText(entry.verbatim) === authoredPromptText(text));
    return known ? isHuman(known) : isHuman({ verbatim: text });
  });
}
