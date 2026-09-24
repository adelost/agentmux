import { feature, component, expect } from "bdd-vitest";
import { assertCodexWorkModel, startCodexProcess, waitForCodexModelSelection } from "./codex-process-launch.mjs";
import { resolveCodexModelSelection, isExpectedCodexModel } from "./codex-profiles.mjs";
import { waitForCodexModelLease } from "./codex-model-command.mjs";

feature("Codex work uses the verified explicit model choice", () => {
  component("an explicit model choice waits through another pane's compact lease", {
    given: ["two lock checks are busy before the owner releases", () => {
      let checks = 0, waits = 0;
      const lease = { release() {} };
      return { queue: { acquireSessionLease: () => ++checks < 3 ? null : lease }, lease,
        wait: async () => { waits++; }, waits: () => waits };
    }],
    when: ["requesting the model-control lease", ctx => waitForCodexModelLease(ctx.queue, "ai", { wait: ctx.wait, attempts: 4 })],
    then: ["the existing owner finishes before control proceeds", (lease, ctx) => { expect(lease).toBe(ctx.lease); expect(ctx.waits()).toBe(2); }],
  });
  component("an empty startup composer is not mistaken for a rendered model footer", {
    given: ["two early empty frames before Sol's footer renders", () => {
      let captures = 0;
      return { screen: async () => ++captures < 3 ? "› Ask Codex to do anything" : "gpt-5.6-sol xhigh · /workspace",
        wait: async () => {}, selected: { model: "gpt-5.6-sol", effort: "xhigh" }, attempts: 4 };
    }],
    when: ["verifying the selected model", args => waitForCodexModelSelection(args)],
    then: ["the observed model is Sol without another model call", actual => expect(actual).toMatchObject({ model: "gpt-5.6-sol", effort: "xhigh" })],
  });
  component("a stopped pane resumes on Luna even when its footer never renders", {
    given: ["an empty composer and a native status that reports Luna", () => ({
      screen: async () => "› Ask Codex to do anything",
      wait: async () => {},
      selected: { model: "gpt-6-luna", effort: "medium" },
      attempts: 2,
      status: async () => ({ ok: true, status: { model: { id: "gpt-6-luna", effort: "medium" } } }),
    })],
    when: ["verifying the resumed model", args => waitForCodexModelSelection(args)],
    then: ["the native status proves Luna rather than reporting running unknown", actual =>
      expect(actual).toMatchObject({ model: "gpt-6-luna", effort: "medium" })],
  });
  component("native status cannot bless a fallback model", {
    given: ["an empty composer but native status reports Sol", () => ({
      screen: async () => "› Ask Codex to do anything",
      wait: async () => {},
      selected: { model: "gpt-6-luna", effort: "medium" },
      attempts: 2,
      status: async () => ({ ok: true, status: { model: { id: "gpt-5.6-sol", effort: "medium" } } }),
    })],
    when: ["verifying the resumed model", args => waitForCodexModelSelection(args)],
    then: ["the mismatch stays visible for the launch guard", actual =>
      expect(actual).toMatchObject({ model: "gpt-5.6-sol", effort: "medium" })],
  });
  component("a stale Sol footer cannot override current Luna status", {
    given: ["the footer still paints Sol while /status has Luna", () => ({
      screen: async () => "› Ask Codex to do anything\n  gpt-5.6-sol medium · /workspace",
      wait: async () => {},
      selected: { model: "gpt-6-luna", effort: "medium" },
      attempts: 2,
      status: async () => ({ ok: true, status: { model: { id: "gpt-6-luna", effort: "medium" } } }),
    })],
    when: ["verifying the resumed model", args => waitForCodexModelSelection(args)],
    then: ["the native status wins", actual => expect(actual.model).toBe("gpt-6-luna")],
  });
  component("model verification crosses startup menus before checking Luna", {
    given: ["an update menu and a paused-goal menu after initial readiness", () => {
      const ctx = { stage: 0, keys: [], selected: { model: "gpt-6-luna", effort: "medium" },
        wait: async () => {}, attempts: 5 };
      const screens = [
        "Update available! 0.155.1 -> 0.156.1\n› 1. Update now\n  2. Skip\nPress enter to continue",
        "Resume paused goal?\nGoal: Old work\n› 1. Resume goal\n  2. Leave paused\nPress enter to confirm or esc to go back",
        "› Ask Codex to do anything\n  gpt-6-luna medium · /workspace",
      ];
      ctx.screen = async () => screens[ctx.stage];
      ctx.dismiss = async prompt => { ctx.keys.push(prompt.keys); ctx.stage++; };
      return ctx;
    }],
    when: ["verifying the requested model", ctx => waitForCodexModelSelection(ctx)],
    then: ["the old goal stays paused and Luna is verified", (actual, ctx) => {
      expect(actual.model).toBe("gpt-6-luna");
      expect(ctx.keys).toEqual(["Down Enter", "Down Enter"]);
    }],
  });
  component("a Luna wake pins only a natively verified model", {
    given: ["a stopped pane with no readable model footer", () => {
      const calls = [];
      return { calls, t: { runShell: async () => calls.push("launch") },
        wait: async () => {}, target: "skyvw:.4", dir: "/workspace/.agents/4",
        profile: { home: "/codex-home" }, selected: { model: "gpt-6-luna", effort: "medium" },
        sessionId: null, previous: null, remembered: null,
        ready: async () => true, screen: async () => "› Ask Codex to do anything",
        status: async () => ({ ok: true, status: { model: { id: "gpt-6-luna", effort: "medium" } } }),
        remember: actual => calls.push(`remember:${actual.model}`),
        pin: actual => calls.push(`pin:${actual.model}`) };
    }],
    when: ["starting the pane", args => startCodexProcess(args)],
    then: ["wake succeeds and keeps Luna selected", (actual, args) => {
      expect(actual.model).toBe("gpt-6-luna");
      expect(args.calls).toEqual(["launch", "remember:gpt-6-luna", "pin:gpt-6-luna"]);
    }],
  });
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
  // lsrc:3, 2026-09-23: no saved pin, config default Sol 5.6, the session
  // itself ran GPT-6 Sol and AMUX relaunched it on GPT-6 Sol from history.
  // The guard judged against the default alone and refused every prompt for
  // eleven hours while `amux ps` called gpt-6-sol the selection.
  for (const [name, history, actual, allowed] of [
    ["an unpinned pane may work on the model its session history selects", "gpt-6-sol", "gpt-6-sol", true],
    ["an unpinned pane still cannot work on a model its history never selected", "gpt-5.6-sol", "gpt-6-sol", false],
  ]) component(name, {
    given: ["no saved pin, the fleet default, session history and the live footer", () => ({
      state: { get: (_key, fallback) => fallback }, name: "lsrc", pane: 3,
      configured: { cmd: "codex --yolo", model: "gpt-5.6-sol" },
      previous: async () => ({ model: history, effort: "xhigh" }),
      screen: async () => `› Ask Codex to do anything\n  ${actual} xhigh · ~/lsrc/.agents/3`,
    })],
    when: ["admitting a work prompt", args => assertCodexWorkModel(args).then(() => true, () => false)],
    then: ["the guard uses the same selection a restart would launch", result => expect(result).toBe(allowed)],
  });
  component("a model refusal is a typed delivery refusal that names both models", {
    given: ["a Sol pin and a GPT-6 footer", () => ({
      state: { get: (key, fallback) => key === "codex_model_by_pane" ? { "lsrc:3": { model: "gpt-5.6-sol" } } : fallback },
      name: "lsrc", pane: 3, configured: { model: "gpt-5.6-sol" },
      screen: async () => "› Ask Codex to do anything\n  gpt-6-sol xhigh · ~/lsrc/.agents/3",
    })],
    when: ["admitting a work prompt", args => assertCodexWorkModel(args).then(() => null, error => error)],
    then: ["delivery can report the real blocker instead of a missing receipt", error => {
      expect(error.code).toBe("AMUX_DELIVERY_REFUSED");
      expect(error.message).toBe("Codex work blocked: selected gpt-5.6-sol, running gpt-6-sol; verify /status before retrying");
    }],
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
