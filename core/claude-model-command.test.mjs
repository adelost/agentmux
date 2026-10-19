import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { keepClaudeDefaultModel } from "./claude-default-model.mjs";
import { paneModelSelection } from "./pane-model-state.mjs";
import { runLockedClaudeModelChange } from "./claude-model-command.mjs";

// api:2 on 2026-10-10: a fresh session's footer shows the model with no context bar.
const FRESH_FOOTER = "❯ \n────\n  ⬆ /gsd-update │ Opus 5.5 │ 2\n  ⏵⏵ bypass permissions on";

// The settings.json every account profile links to, as lsrc:0 left it at 14:38Z on 2026-10-19.
const SETTINGS = `${JSON.stringify({ model: "opus[1m]", theme: "dark" }, null, 2)}\n`;

function fixture({ compactOk = true, pending = false, liveModel = "claude-opus-5", running = true,
  screen = null, compactResult = null, footerFor = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-claude-model-change-"));
  const path = join(root, "session.jsonl");
  writeFileSync(path, "");
  const settingsPath = join(root, "settings.json");
  writeFileSync(settingsPath, SETTINGS);
  const data = { watcher_last_model: { "claw:0": { model: "claude-opus-5", effort: "high" } } };
  const state = { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  const calls = [];
  let model = liveModel;
  const agent = {
    paneProcessState: async () => ({ running }),
    isBusy: async () => false,
    promptTransportState: async () => ({ state: "empty-idle" }),
    getContext: async () => ({ model, effort: "high" }),
    ...(screen ? { captureScreen: async () => screen } : {}),
  };
  const queue = {
    acquireSessionLease: () => ({ release: () => calls.push("release") }),
    list: () => pending ? [{ status: "pending" }] : [],
  };
  const identityFor = () => ({ sessionId: "11111111-1111-4111-8111-111111111111", path });
  const compact = async () => {
    calls.push("compact");
    if (compactResult) return compactResult(identityFor());
    if (!compactOk) return { ok: false, reason: "compact-boundary-missing" };
    appendFileSync(path, `${JSON.stringify({ type: "system", subtype: "compact_boundary" })}\n`);
    return { ok: true, sessionId: identityFor().sessionId, cursor: { positions: { [path]: 0 } }, compactBoundary: true };
  };
  // Claude Code resolves an alias itself, shows the model in its footer and
  // saves every interactive pick as the default for new sessions (2.1.303).
  const sendSlash = async (_agent, _name, _pane, command) => {
    calls.push(command);
    const picked = command.replace("/model ", "");
    model = footerFor[picked] ?? picked;
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    writeFileSync(settingsPath, `${JSON.stringify({ ...settings, model: picked }, null, 2)}\n`);
    return { delivered: true, via: "command-receipt" };
  };
  const keepDefault = work => keepClaudeDefaultModel(work, { files: [settingsPath],
    lockPath: join(root, "default.lock"), wait: async () => {}, lateWriteMs: 0 });
  const change = targetModel => runLockedClaudeModelChange({
    agent, state, queue, name: "claw", pane: 0, paneDir: root, targetModel,
    identityFor, compact, sendSlash, wait: async () => {}, keepDefault,
  });
  return { change, calls, state, settings: () => readFileSync(settingsPath, "utf-8"),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("Claude model changes are compact-first and pane-local", () => {
  component("Claude's live display name is the same Opus 5.5 model", {
    given: ["the real footer spelling Opus 5.5 and an older saved choice", () => fixture({ liveModel: "Opus 5.5" })],
    when: ["selecting the exact Opus 5.5 id", fx => fx.change("claude-opus-5-5")],
    then: ["no paid compact or model switch is needed", (result, fx) => {
      try {
        expect(result.ok).toBe(true);
        expect(result.unchanged).toBe(true);
        expect(fx.calls).toEqual([]);
        expect(paneModelSelection(fx.state, "claw", 0)?.model).toBe("claude-opus-5-5");
      } finally { fx.cleanup(); }
    }],
  });
  component("Claude's older display name still compacts before a new model", {
    given: ["the real footer spelling Opus 5", () => fixture({ liveModel: "Opus 5" })],
    when: ["requesting Opus 5.5", fx => fx.change("claude-opus-5-5")],
    then: ["the verified compact precedes the switch", (result, fx) => {
      try { expect(result.ok).toBe(true); expect(fx.calls).toEqual(["compact", "/model claude-opus-5-5", "release"]); }
      finally { fx.cleanup(); }
    }],
  });
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
  component("a fresh pane whose footer already shows the target is not compacted", {
    given: ["the journal still says Opus 5 but the bar-less footer says Opus 5.5", () =>
      fixture({ liveModel: "claude-opus-5", screen: FRESH_FOOTER })],
    when: ["requesting opus 5.5 as Mattias typed it", fx => fx.change("claude-opus-5-5")],
    then: ["it answers already using the model, without compact or switch", (result, fx) => {
      try {
        expect(result).toMatchObject({ ok: true, unchanged: true, model: "claude-opus-5-5" });
        expect(fx.calls).toEqual([]);
      } finally { fx.cleanup(); }
    }],
  });
  component("nothing to compact changes the model without a compact boundary", {
    given: ["Claude answered the compact with Not enough messages to compact", () => fixture({
      compactResult: (identity) => ({ ok: false, reason: "compact-nothing-to-compact", nothingToCompact: true,
        sessionId: identity.sessionId, cursor: { positions: {} } }) })],
    when: ["requesting Opus 5.5", fx => fx.change("claude-opus-5-5")],
    then: ["the model command follows and the selection persists", (result, fx) => {
      try {
        expect(result.ok).toBe(true);
        expect(fx.calls).toEqual(["compact", "/model claude-opus-5-5", "release"]);
        expect(paneModelSelection(fx.state, "claw", 0)?.model).toBe("claude-opus-5-5");
      } finally { fx.cleanup(); }
    }],
  });
});

// claw:0 on 2026-10-19: `amux model skydive -p 1 sonnet` switched the pane, but
// amux compared "sonnet" with the footer's Sonnet 5.5, answered
// model-status-unverified and saved nothing, so a restart would bring Opus back.
feature("a family alias selects the model its footer shows", () => {
  component("switching with the alias sonnet saves the full id", {
    given: ["an idle Opus 5.5 pane whose footer will show Sonnet 5.5", () =>
      fixture({ liveModel: "claude-opus-5-5", footerFor: { sonnet: "Sonnet 5.5" } })],
    when: ["running amux model with sonnet", fx => fx.change("sonnet")],
    then: ["the switch is verified and claude-sonnet-5-5 is the pane's choice", (result, fx) => {
      try {
        expect(result).toMatchObject({ ok: true, model: "claude-sonnet-5-5" });
        expect(fx.calls).toEqual(["compact", "/model sonnet", "release"]);
        expect(paneModelSelection(fx.state, "claw", 0)?.model).toBe("claude-sonnet-5-5");
      } finally { fx.cleanup(); }
    }],
  });
  component("a pane already on Sonnet 5.5 spends nothing for the alias", {
    given: ["a pane whose footer shows Sonnet 5.5", () => fixture({ liveModel: "Sonnet 5.5" })],
    when: ["running amux model with sonnet", fx => fx.change("sonnet")],
    then: ["no compact or switch, and the full id is saved", (result, fx) => {
      try {
        expect(result).toMatchObject({ ok: true, unchanged: true, model: "claude-sonnet-5-5" });
        expect(fx.calls).toEqual([]);
        expect(paneModelSelection(fx.state, "claw", 0)?.model).toBe("claude-sonnet-5-5");
      } finally { fx.cleanup(); }
    }],
  });
});

// lsrc:0 on 2026-10-19: every switch made Claude Code save the builder's model
// as the default in the settings.json all profiles share, so a session started
// by hand ran Sonnet. lsrc:0 put "opus[1m]" back by hand at 14:38Z.
feature("a pane switch leaves the default for new sessions alone", () => {
  component("switching a builder to Sonnet keeps the shared default", {
    given: ["an idle Opus 5.5 pane and the shared settings with opus[1m]", () => fixture({ liveModel: "claude-opus-5-5" })],
    when: ["running amux model with claude-sonnet-5-5", fx => fx.change("claude-sonnet-5-5")],
    then: ["the pane runs Sonnet and the settings file is byte for byte the one before", (result, fx) => {
      try {
        expect(result).toMatchObject({ ok: true, model: "claude-sonnet-5-5" });
        expect(fx.settings()).toBe(SETTINGS);
      } finally { fx.cleanup(); }
    }],
  });
});
