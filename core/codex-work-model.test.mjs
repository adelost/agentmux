import { feature, component, expect } from "bdd-vitest";
import { assertCodexWorkModel } from "./codex-process-launch.mjs";
import { resolveCodexModelSelection, isExpectedCodexModel } from "./codex-profiles.mjs";

feature("Codex work uses the verified explicit model choice", () => {
  component("raw model administration cannot bypass compact-first controls", {
    when: ["a queued raw /model reaches the physical send boundary", () => assertCodexWorkModel({
      name: "claw", pane: 4, prompt: "/model gpt-6-astra",
    }).then(() => null, error => error.message)],
    then: ["the command is refused before any model or terminal call", message => expect(message).toContain("use amux model claw -p 4")],
  });
  for (const [name, wanted, actual, blocked, allowed] of [
    ["Sol work cannot start on Astra", "gpt-5.6-sol", "gpt-6-astra", false, false],
    ["Sol work can start on Sol", "gpt-5.6-sol", "gpt-5.6-sol", false, true],
    ["a later explicit Astra choice remains permitted", "gpt-6-astra", "gpt-6-astra", false, true],
    ["missing live evidence blocks work", "gpt-5.6-sol", null, false, false],
    ["failed compact blocks work even on the desired model", "gpt-5.6-sol", "gpt-5.6-sol", true, false],
  ]) component(name, {
    given: ["a saved choice and observed TUI, with no model process", () => {
      const data = { codex_model_by_pane: { "claw:4": { model: wanted } },
        codex_session_by_pane_profile_v1: { "claw:4@1": { modelTransitionBlocked: blocked ? { reason: "compact-unverified" } : null } } };
      return { state: { get: (key, fallback) => data[key] ?? fallback }, name: "claw", pane: 4,
        configured: { model: "gpt-5.6-sol" }, screen: async () => actual ? `› Ask Codex to do anything\n${actual} xhigh · /workspace` : "unreadable" };
    }],
    when: ["admitting a work prompt", args => assertCodexWorkModel(args).then(() => true, () => false)],
    then: ["only the proven selection can spend the prompt", result => expect(result).toBe(allowed)],
  });
  component("restart retains a known session choice over a changed default", {
    when: ["resolving a restart without a new user selection", () => resolveCodexModelSelection({
      configured: { model: "gpt-5.6-sol" }, previous: { model: "gpt-6-astra", effort: "xhigh" },
    })],
    then: ["the previous choice survives", result => expect(result).toMatchObject({ model: "gpt-6-astra", source: "history" })],
  });
  component("an intentional Sol observation is not an involuntary downgrade", {
    when: ["checking the declared pane selection", () => isExpectedCodexModel(null, "claw", 4,
      { cmd: "codex", model: "gpt-5.6-sol" }, { model: "gpt-5.6-sol" })],
    then: ["the watcher accepts the requested model", result => expect(result).toBe(true)],
  });
});
