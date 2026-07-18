import { component, expect, feature } from "bdd-vitest";
import { findBlockingPrompt } from "./dismiss.mjs";

const activeSafetyReview = `
Additional safety checks
This request requires additional safety checks, which can take extra time.

› 1. Retry with a faster model
  2. Keep waiting
  3. Learn more

Press enter to confirm or esc to go back
`;

feature("blocking prompt recognition", () => {
  component("additional safety review keeps waiting without changing model", {
    when: ["the exact active provider menu is visible", () => findBlockingPrompt(activeSafetyReview)],
    then: ["the non-bypass continuation choice is selected", (prompt) => {
      expect(prompt).toMatchObject({
        name: "additional-safety-check",
        keys: "Down Enter",
      });
    }],
  });

  component("stale safety prose never receives navigation keys", {
    when: ["the old menu is followed by a real composer", () => findBlockingPrompt(
      `${activeSafetyReview}\n› write a new request\n`,
    )],
    then: ["no active blocker is inferred from scrollback", (prompt) => {
      expect(prompt).toBeNull();
    }],
  });
});
