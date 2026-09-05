import { feature, unit, expect } from "bdd-vitest";
import { listPanes, selectOption } from "../cli/tmux.mjs";

feature("pane process lifecycle evidence", () => {
  unit("pane_dead survives enumeration even when the command still says node", {
    when: ["enumerating one alive and one exited node process", async () => {
      const commands = [];
      const panes = await listPanes({ tmux: async (command) => {
        commands.push(command);
        return { stdout: "0|120x40|node|0\n1|120x40|node|1\n" };
      } }, "fixture");
      return { commands, panes };
    }],
    then: ["one read carries independent process-death evidence for both rows", ({ commands, panes }) => {
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain("#{pane_dead}");
      expect(panes).toEqual([
        { index: 0, width: 120, height: 40, command: "node", dead: false },
        { index: 1, width: 120, height: 40, command: "node", dead: true },
      ]);
    }],
  });
});

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
