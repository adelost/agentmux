import { vi } from "vitest";
import { feature, component, expect } from "bdd-vitest";
import { inspectPane } from "./inspect-pane.mjs";
import { formatPaneModel, shouldExpandPane } from "./pane-model-view.mjs";
import { getContextPercent } from "../core/context.mjs";

vi.mock("../core/context.mjs", async (original) => ({
  ...await original(), getContextPercent: vi.fn(),
}));
vi.mock("../core/events.mjs", () => ({
  latestPaneStatesCached: () => new Map([["fixture:0", { status: "working" }]]),
  mergeStatus: (status, hook) => ({ status: hook?.status || status }),
}));
vi.mock("../core/jsonl-reader.mjs", () => ({
  panePathFor: () => "/fixture/.agents/0", latestJsonlMtime: () => Date.now(),
}));
vi.mock("../core/alternate-session-reader.mjs", () => ({
  alternateEngineForCommand: () => "codex", latestAlternateMtime: () => Date.now(),
}));

const OLD = { model: "gpt-5.6-sol", effort: "max", percent: 40, tokens: 102_500 };
const NEXT = { model: "gpt-6-astra", effort: "xhigh" };
const agent = { name: "fixture", dir: "/fixture", panes: [{ cmd: "codex" }] };
const STATUS = [
  "╭──────────────────────────────────────────────────────────────────────╮",
  "│ >_ OpenAI Codex (v0.153.4)                                           │",
  "│ Model: gpt-6-astra (reasoning xhigh, summaries auto)                   │",
  "│ Session: fixture-session                                           │",
  "│ Context window: 65% left (98.4K used / 258K)                          │",
  "╰──────────────────────────────────────────────────────────────────────╯",
  "› Ask Codex to do anything",
  "  gpt-6-astra xhigh · ~/fixture",
].join("\n");

function fixture({ usage = null, override = null, capture = "$ ", command = "node", dead = false } = {}) {
  getContextPercent.mockReturnValue(usage);
  return {
    agent: { capturePane: vi.fn(async () => capture) },
    state: { get: (key, fallback) => key === "codex_model_by_pane" ? { "fixture:0": override } : fallback },
    pane: { index: 0, command, dead },
  };
}

feature("model and process evidence in amux ps", () => {
  component("a dormant pane shows its source-configured model without turning history into intent", {
    given: ["old session usage, a new YAML model, and no manual override", () =>
      fixture({ command: "bash", usage: OLD })],
    when: ["inspecting the generated model field", (ctx) => inspectPane(ctx, {
      ...agent, panes: [{ cmd: "codex", model: NEXT.model }],
    }, ctx.pane)],
    then: ["the next start model is configured, not a claimed live observation", (row) => {
      expect(row.context).toBeNull();
      expect(row.modelView.selected).toEqual({ model: NEXT.model, effort: OLD.effort, source: "config" });
      expect(formatPaneModel(row)).toBe("stopped; gpt-6-astra·max [configured]; last: gpt-5.6-sol·max");
    }],
  });

  for (const pane of [{ command: "bash" }, { command: "node", dead: true }]) {
    component(`exited ${pane.command} cannot present old usage as a running model`, {
      given: ["a recent old rollout, saved new choice and stale UI", () =>
        fixture({ ...pane, usage: OLD, override: NEXT, capture: STATUS })],
      when: ["inspecting without starting or steering anything", (ctx) => inspectPane(ctx, agent, ctx.pane)],
      then: ["history and intent are labelled and live usage is absent", (row) => {
        expect(row.status).toBe("unknown");
        expect(row.context).toBeNull();
        expect(row.modelView.running).toBe(false);
        expect(shouldExpandPane(row)).toBe(true);
        expect(formatPaneModel(row)).toBe("stopped; gpt-6-astra·xhigh [configured]; last: gpt-5.6-sol·max");
      }],
    });
  }

  component("a resumed Codex status screen has a selected model before any usage event", {
    given: ["the real status shape after resuming an old session", () => fixture({ capture: STATUS })],
    when: ["inspecting", (ctx) => inspectPane(ctx, agent, ctx.pane)],
    then: ["the native percentage and selection survive missing JSONL", (row) => {
      expect(row.context).toMatchObject({ percent: 35, tokens: 98_400, windowTokens: 258_000, source: "codex-status" });
      expect(row.modelView.observed).toBeNull();
      expect(formatPaneModel(row)).toBe("gpt-6-astra·xhigh [selected]");
      expect(shouldExpandPane(row)).toBe(true);
    }],
  });

  component("a model footer does not fabricate usage or overwrite the previous turn", {
    given: ["a live new selection with an older usage observation", () => fixture({
      usage: OLD, override: { model: "gpt-other", effort: "medium" },
      capture: "› Ask Codex to do anything\n  gpt-6-astra xhigh · ~/fixture",
    })],
    when: ["inspecting", (ctx) => inspectPane(ctx, agent, ctx.pane)],
    then: ["both sources remain visible and the last usage model stays intact", (row) => {
      expect(row.context).toEqual(OLD);
      expect(formatPaneModel(row)).toBe("gpt-6-astra·xhigh [selected]; last: gpt-5.6-sol·max");
    }],
  });

  component("a current native status percentage outranks reconstructed JSONL usage", {
    given: ["old turn usage and a complete current status box", () => fixture({ usage: OLD, capture: STATUS })],
    when: ["inspecting without changing either observation", (ctx) => inspectPane(ctx, agent, ctx.pane)],
    then: ["the engine-reported percentage wins while old model evidence stays labelled", (row) => {
      expect(row.context).toMatchObject({ percent: 35, tokens: 98_400, source: "codex-status", confidence: "reported" });
      expect(row.modelView.observed).toEqual({ model: OLD.model, effort: OLD.effort });
      expect(formatPaneModel(row)).toBe("gpt-6-astra·xhigh [selected]; last: gpt-5.6-sol·max");
    }],
  });

  component("a pager exposes the pane override as configured, never served", {
    given: ["a pager hiding all model and context chrome", () => fixture({
      override: NEXT, capture: "/ T R A N S C R I P T /\nq to quit",
    })],
    when: ["inspecting", (ctx) => inspectPane(ctx, agent, ctx.pane)],
    then: ["missing data stays missing while the intended model stays visible", (row) => {
      expect(row.context).toBeNull();
      expect(row.modelView.observed).toBeNull();
      expect(formatPaneModel(row)).toBe("gpt-6-astra·xhigh [configured]");
      expect(shouldExpandPane(row)).toBe(true);
    }],
  });

  component("no evidence never falls back to a fleet default or another pane's choice", {
    given: ["a node pane with no model evidence", () => {
      const ctx = fixture();
      ctx.state.get = () => ({ "fixture:1": NEXT });
      return ctx;
    }],
    when: ["inspecting", (ctx) => inspectPane(ctx, agent, ctx.pane)],
    then: ["both readings are absent", (row) => {
      expect(row.context).toBeNull();
      expect(row.modelView).toEqual({ running: true, observed: null, selected: null });
    }],
  });

  component("native runtime models remain visible when context telemetry is absent", {
    given: ["a native idle session with divergent observed and requested models", () => ({
      agent: { nativeRuntime: { history: async () => ({
        agent: { running: false, model: NEXT.model, effort: NEXT.effort,
          observedModel: OLD.model, observedEffort: OLD.effort }, events: [],
      }) } },
    })],
    when: ["inspecting", (ctx) => inspectPane(ctx, { ...agent, backend: "native" }, { index: 0 })],
    then: ["idle is not stopped and missing context does not hide either model", (row) => {
      expect(row.status).toBe("idle");
      expect(row.context).toBeNull();
      expect(row.modelView.running).toBe(true);
      expect(formatPaneModel(row)).toBe("gpt-6-astra·xhigh [selected]; last: gpt-5.6-sol·max");
      expect(shouldExpandPane(row)).toBe(true);
    }],
  });
});
