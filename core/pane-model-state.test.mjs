import { expect, feature, unit } from "bdd-vitest";
import {
  paneModelSelection,
  setPaneModelSelection,
} from "./pane-model-state.mjs";

function memoryState(seed = {}) {
  const data = { ...seed };
  return {
    data,
    get: (key, fallback) => key in data ? data[key] : fallback,
    set: (key, value) => { data[key] = value; return value; },
  };
}

feature("durable pane model selection", () => {
  unit("a Fable choice survives independently per pane", {
    given: ["two configured panes", () => memoryState()],
    when: ["remembering Fable only for pane 6", (state) => {
      setPaneModelSelection(state, "claw", 6, "claude-fable-5");
      return {
        selected: paneModelSelection(state, "claw", 6),
        neighbour: paneModelSelection(state, "claw", 5),
      };
    }],
    then: ["restart lookup keeps Fable local to pane 6", ({ selected, neighbour }) => {
      expect(selected).toEqual({ model: "claude-fable-5", effort: null });
      expect(neighbour).toBeNull();
    }],
  });

  unit("the historical watcher map is read without migration loss", {
    given: ["pre-upgrade watcher state", () => memoryState({
      watcher_last_model: { "skydive:3": { model: "fable", effort: null } },
    })],
    when: ["reading the pane after upgrade", (state) => paneModelSelection(state, "skydive", 3)],
    then: ["the prior selection remains authoritative", (selection) =>
      expect(selection).toEqual({ model: "fable", effort: null })],
  });
});
