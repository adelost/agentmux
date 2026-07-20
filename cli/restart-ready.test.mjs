import { expect, feature, unit } from "bdd-vitest";
import {
  combinedPanelRestartState,
  nativePanelRestartState,
  panelRestartState,
  parseTmuxPaneRows,
  parseTmuxSessionRows,
  restartPaneEngine,
} from "./restart-ready.mjs";

feature("restart-ready inventory adapters", () => {
  unit("only coding panes enter the inventory", {
    then: ["engine declarations and commands normalize exactly", () => {
      expect(restartPaneEngine({ engine: "kimi", cmd: "anything" })).toBe("kimi");
      expect(restartPaneEngine({ cmd: "codex --yolo" })).toBe("codex");
      expect(restartPaneEngine({ cmd: "/opt/kimi-code --auto" })).toBe("kimi");
      expect(restartPaneEngine({ cmd: "bash" })).toBeNull();
    }],
  });

  unit("durable journal completion is the panel safety boundary", {
    then: ["complete is idle, incomplete active, missing unknown", () => {
      expect(panelRestartState([{ isComplete: true }]))
        .toEqual({ state: "idle", reason: "turn-complete" });
      expect(panelRestartState([{ isComplete: false }]))
        .toEqual({ state: "active", reason: "turn-incomplete" });
      expect(panelRestartState([]))
        .toEqual({ state: "unknown", reason: "journal-missing" });
    }],
  });

  unit("tmux identity rows remain stable generation inputs", {
    then: ["id, name, creation time, and identity are preserved", () => {
      expect(parseTmuxSessionRows("$1\tlsrc\t123\n$2\tai\t456\n")).toEqual([
        { id: "$1", name: "lsrc", created: "123", identity: "$1:lsrc:123" },
        { id: "$2", name: "ai", created: "456", identity: "$2:ai:456" },
      ]);
    }],
  });

  unit("native process residence is not confused with an active turn", {
    then: ["only an unmatched user event blocks restart", () => {
      const user = { type: "web", subtype: "user", operationKey: "op-1" };
      expect(nativePanelRestartState([])).toEqual({ state: "idle", reason: "no-native-turn" });
      expect(nativePanelRestartState([user]))
        .toEqual({ state: "active", reason: "native-turn-incomplete" });
      expect(nativePanelRestartState([
        user,
        { type: "web", subtype: "turn-done", operationKey: "op-1" },
      ])).toEqual({ state: "idle", reason: "native-turn-complete" });
    }],
  });

  unit("live pane paths stay available to dirty-worktree discovery", {
    then: ["session, pane, and exact cwd are parsed", () => {
      expect(parseTmuxPaneRows("lsrc\t3\t/home/adelost/lsrc/.agents/3\n"))
        .toEqual([{ agent: "lsrc", pane: 3, path: "/home/adelost/lsrc/.agents/3" }]);
    }],
  });

  unit("old interrupted journals do not impersonate a current active turn", {
    then: ["live non-idle status blocks while proven idle status remains restartable", () => {
      expect(combinedPanelRestartState(
        { state: "active", reason: "turn-incomplete" },
        "idle",
      )).toEqual({ state: "idle", reason: "prior-turn-interrupted" });
      expect(combinedPanelRestartState(
        { state: "idle", reason: "turn-complete" },
        "working",
      )).toEqual({ state: "active", reason: "pane-working" });
      expect(combinedPanelRestartState(
        { state: "idle", reason: "turn-complete" },
        "unknown",
      )).toEqual({ state: "unknown", reason: "pane-status-unknown" });
    }],
  });
});
