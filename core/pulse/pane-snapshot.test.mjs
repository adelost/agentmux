// Guards pulse-11 (docs/DESIGN-pulse.md): the bridge's watchers share one tmux pane listing per round,
// and a listing row reads the way paneProcessState answers.

import { feature, unit, expect } from "bdd-vitest";
import { createPaneSnapshot, processStateOf } from "./pane-snapshot.mjs";

feature("shared pane listing", () => {
  unit("watchers within two seconds share one listing", {
    given: ["a listing that counts its tmux questions and a clock the test moves", () => {
      const world = { t: 0, asked: 0 };
      const tmux = { listAllPanes: async () => {
        world.asked++;
        return new Map([["lsrc:0", { index: 0, id: "%1", command: "claude", dead: false, path: "/w", pid: 41 }]]);
      } };
      return { world, snapshot: createPaneSnapshot({ tmux, now: () => world.t }) };
    }],
    when: ["three watchers read at 0 s, 1.5 s and 2.5 s", async ({ world, snapshot }) => {
      await snapshot.panes();
      world.t = 1500; await snapshot.panes();
      world.t = 2500; const rows = await snapshot.panes();
      return { asked: world.asked, running: processStateOf(rows.get("lsrc:0")), missing: processStateOf(rows.get("lsrc:9")) };
    }],
    then: ["two questions, and rows read as paneProcessState answers", ({ asked, running, missing }) => {
      expect(asked).toBe(2);
      expect(running).toEqual({ command: "claude", dead: false, shell: false, running: true });
      expect(missing).toEqual({ command: null, dead: false, shell: false, running: false });
    }],
  });
});
