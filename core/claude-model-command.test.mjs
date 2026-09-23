import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { paneModelSelection } from "./pane-model-state.mjs";
import { runLockedClaudeModelChange } from "./claude-model-command.mjs";

function fixture({ compactOk = true, pending = false, liveModel = "claude-opus-5", running = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-claude-model-change-"));
  const path = join(root, "session.jsonl");
  writeFileSync(path, "");
  const data = { watcher_last_model: { "claw:0": { model: "claude-opus-5", effort: "high" } } };
  const state = { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  const calls = [];
  let model = liveModel;
  const agent = {
    paneProcessState: async () => ({ running }),
    isBusy: async () => false,
    promptTransportState: async () => ({ state: "empty-idle" }),
    getContext: async () => ({ model, effort: "high" }),
  };
  const queue = {
    acquireSessionLease: () => ({ release: () => calls.push("release") }),
    list: () => pending ? [{ status: "pending" }] : [],
  };
  const identityFor = () => ({ sessionId: "11111111-1111-4111-8111-111111111111", path });
  const compact = async () => {
    calls.push("compact");
    if (!compactOk) return { ok: false, reason: "compact-boundary-missing" };
    appendFileSync(path, `${JSON.stringify({ type: "system", subtype: "compact_boundary" })}\n`);
    return { ok: true, sessionId: identityFor().sessionId, cursor: { positions: { [path]: 0 } }, compactBoundary: true };
  };
  const sendSlash = async (_agent, _name, _pane, command) => {
    calls.push(command);
    model = command.replace("/model ", "");
    return { delivered: true, via: "command-receipt" };
  };
  const change = targetModel => runLockedClaudeModelChange({
    agent, state, queue, name: "claw", pane: 0, paneDir: root, targetModel,
    identityFor, compact, sendSlash, wait: async () => {},
  });
  return { change, calls, state, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("Claude model changes are compact-first and pane-local", () => {
  component("a stopped pane is not woken solely to change models", {
    given: ["the pane process is asleep", () => fixture({ running: false })],
    when: ["requesting Opus 5.5", fx => fx.change("claude-opus-5-5")],
    then: ["the choice waits without compact or wake", (result, fx) => {
      try { expect(result.ok).toBe(false); expect(result.stage).toBe("stopped"); expect(fx.calls).toEqual([]); }
      finally { fx.cleanup(); }
    }],
  });
  component("a missing target cannot select a fleet default", {
    given: ["an idle pane but no model name", fixture],
    when: ["requesting a change without a target", fx => fx.change(undefined)],
    then: ["the request is refused without touching the pane", (result, fx) => {
      try { expect(result.ok).toBe(false); expect(fx.calls).toEqual([]); }
      finally { fx.cleanup(); }
    }],
  });
  component("an already-selected live model corrects stale durable state without compact", {
    given: ["the footer says Opus 5.5 while the saved choice still says Opus 5", () => fixture({ liveModel: "claude-opus-5-5" })],
    when: ["selecting the live model", fx => fx.change("claude-opus-5-5")],
    then: ["the live choice persists without a paid action", (result, fx) => {
      try {
        expect(result.ok).toBe(true);
        expect(result.unchanged).toBe(true);
        expect(fx.calls).toEqual([]);
        expect(paneModelSelection(fx.state, "claw", 0)).toEqual({ model: "claude-opus-5-5", effort: "high" });
      } finally { fx.cleanup(); }
    }],
  });
  component("an unchanged model spends nothing", {
    given: ["Opus 5 already selected", fixture],
    when: ["requesting the same model", fx => fx.change("claude-opus-5")],
    then: ["no compact or model command is sent", (result, fx) => {
      try { expect(result.ok).toBe(true); expect(result.unchanged).toBe(true); expect(fx.calls).toEqual([]); }
      finally { fx.cleanup(); }
    }],
  });
  component("a changed model follows an exact compact boundary", {
    given: ["an idle Opus 5 pane", fixture],
    when: ["requesting Opus 5.5", fx => fx.change("claude-opus-5-5")],
    then: ["compact precedes the switch and the selection persists", (result, fx) => {
      try {
        expect(result.ok).toBe(true);
        expect(fx.calls).toEqual(["compact", "/model claude-opus-5-5", "release"]);
        expect(paneModelSelection(fx.state, "claw", 0)).toEqual({ model: "claude-opus-5-5", effort: "high" });
      } finally { fx.cleanup(); }
    }],
  });
  component("a failed compact never reaches the model command", {
    given: ["a compact without a verified boundary", () => fixture({ compactOk: false })],
    when: ["requesting Opus 5.5", fx => fx.change("claude-opus-5-5")],
    then: ["the old selection remains and no paid retry is automatic", (result, fx) => {
      try {
        expect(result.ok).toBe(false);
        expect(fx.calls).toEqual(["compact", "release"]);
        expect(paneModelSelection(fx.state, "claw", 0)?.model).toBe("claude-opus-5");
      } finally { fx.cleanup(); }
    }],
  });
  component("an older queued user message is not overtaken", {
    given: ["a pending message for the same pane", () => fixture({ pending: true })],
    when: ["requesting Opus 5.5", fx => fx.change("claude-opus-5-5")],
    then: ["no compact or model command is submitted", (result, fx) => {
      try { expect(result.ok).toBe(false); expect(fx.calls).toEqual(["release"]); }
      finally { fx.cleanup(); }
    }],
  });
});
