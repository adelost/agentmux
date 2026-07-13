import { feature, unit, expect } from "bdd-vitest";
import { DEFAULT_TMUX_LAYOUT, resolveTmuxLayout } from "./layout.mjs";

feature("tmux layout resolution", () => {
  unit("uses tiled only when no explicit layout exists", {
    given: ["missing and explicit layout values", () => [undefined, null, " main-vertical "]],
    when: ["resolving them", (values) => values.map(resolveTmuxLayout)],
    then: ["missing values use the shared default and explicit input is trimmed", (layouts) => {
      expect(DEFAULT_TMUX_LAYOUT).toBe("tiled");
      expect(layouts).toEqual(["tiled", "tiled", "main-vertical"]);
    }],
  });

  unit("rejects malformed explicit layouts", {
    given: ["blank and non-string values", () => ["  ", false, 7]],
    when: ["resolving each value", (values) => values.map((value) => {
      try {
        resolveTmuxLayout(value);
        return null;
      } catch (error) {
        return error.message;
      }
    })],
    then: ["every malformed value fails loudly", (messages) => {
      expect(messages).toEqual(Array(3).fill("tmux layout must be a non-empty string"));
    }],
  });
});
