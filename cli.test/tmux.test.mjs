import { feature, unit, expect } from "bdd-vitest";
import { selectOption } from "../cli/tmux.mjs";

feature("menu selection", () => {
  unit("option numbers are 1-based", {
    when: ["selecting the first and second options", async () => {
      const first = [];
      const second = [];
      await selectOption({ tmux: async (cmd) => first.push(cmd) }, "api", 0, 1);
      await selectOption({ tmux: async (cmd) => second.push(cmd) }, "api", 0, 2);
      return { first, second };
    }],
    then: ["the first option needs no Down key and the second needs one", ({ first, second }) => {
      expect(first.filter((cmd) => cmd.endsWith(" Down"))).toHaveLength(0);
      expect(second.filter((cmd) => cmd.endsWith(" Down"))).toHaveLength(1);
      expect(first.at(-1)).toMatch(/ Enter$/);
      expect(second.at(-1)).toMatch(/ Enter$/);
    }],
  });
});
