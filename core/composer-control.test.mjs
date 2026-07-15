import { feature, unit, expect } from "bdd-vitest";
import {
  CLEARLINE_RECIPE,
  COMPOSER_KEY_ALLOWLIST,
  escapeComposerRecipe,
  normalizeComposerKeys,
} from "./composer-control.mjs";

feature("bounded composer key contract", () => {
  unit("the public surface accepts only the five exact recovery keys", {
    when: ["normalizing every documented key", () =>
      normalizeComposerKeys(COMPOSER_KEY_ALLOWLIST)],
    then: ["the immutable order is preserved", (keys) => {
      expect(keys).toEqual(["Escape", "C-a", "C-k", "C-u", "Enter"]);
      expect(Object.isFrozen(keys)).toBe(true);
    }],
  });

  unit("tmux flags, text, pager q and case variants fail before dispatch", {
    when: ["trying non-allowlisted tokens", () =>
      ["-X", "hello", "q", "escape"].map((key) => {
        try { normalizeComposerKeys([key]); return null; }
        catch (error) { return error.message; }
      })],
    then: ["every token is rejected", (errors) =>
      expect(errors.every((message) => /not allowed/u.test(message))).toBe(true)],
  });

  unit("clearline never regresses to the ineffective Codex C-u recipe", {
    then: ["the recipe is exact", () => {
      expect(CLEARLINE_RECIPE).toEqual(["Escape", "C-a", "C-k"]);
      expect(CLEARLINE_RECIPE).not.toContain("C-u");
    }],
  });

  unit("verified Codex transcript and backtrack pagers use internal q", {
    when: ["planning both pager variants", () => [
      escapeComposerRecipe("/ T R A N S C R I P T /\nq to quit"),
      escapeComposerRecipe("q to quit · ↑ to edit prev · ↓ to edit next"),
      escapeComposerRecipe("› normal composer"),
    ]],
    then: ["only the verified pagers get q", (recipes) => {
      expect(recipes).toEqual([
        { keys: ["q"], pager: true },
        { keys: ["q"], pager: true },
        { keys: ["Escape"], pager: false },
      ]);
    }],
  });
});
