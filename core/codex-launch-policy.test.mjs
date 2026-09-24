import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchCodexWithPolicy, codexResumeEvidence } from "./codex-launch-policy.mjs";
import { readCodexRolloutModel } from "./codex-rollout-model.mjs";

const fixture = (extra = {}) => {
  const events = [];
  return { events, sessionId: "session-a", previous: { model: "gpt-6-astra" },
    selected: { model: "gpt-5.6-sol", effort: "xhigh" },
    launch: async ({ model }) => events.push(`launch:${model}`),
    compact: async () => { events.push("compact"); return { ok: true, sessionId: "session-a" }; },
    reset: async () => events.push("reset"),
    verify: async () => ({ model: "gpt-5.6-sol", effort: "xhigh" }),
    remember: (actual) => events.push(`remember:${actual.model}`),
    recordBlocked: () => events.push("blocked"),
    validReceipt: (r, id) => r?.ok === true && r.sessionId === id,
    ...extra };
};

feature("Codex wake cannot bypass compact-first model selection", () => {
  component("the exact rollout yields its latest model even when bounded status scans cannot see it", {
    when: ["reading a model between a long head and a long tool tail", async () => {
      const root = mkdtempSync(join(tmpdir(), "codex-rollout-model-"));
      const path = join(root, "rollout.jsonl");
      try {
        const padding = (count) => `${JSON.stringify({ type: "event_msg", payload: { type: "tool_output", text: "x".repeat(count) } })}\n`;
        const model = JSON.stringify({ type: "turn_context", payload: { model: "gpt-6-sol",
          collaboration_mode: { settings: { reasoning_effort: "xhigh" } } } });
        writeFileSync(path, `${padding(300_000)}${model}\n${padding(9 * 1024 * 1024)}`);
        return await readCodexRolloutModel(path, "session-a");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
    then: ["only the exact recorded model and effort are returned", model =>
      expect(model).toEqual({ sessionId: "session-a", model: "gpt-6-sol", effort: "xhigh" })],
  });
  component("an exact rollout model hidden beyond the status tail still requires compact before changing model", {
    given: ["a stopped Sol session whose last rollout model is known but status has no model", () => codexResumeEvidence({
      sessionId: "session-a", observed: { sessionId: "session-a", model: null },
      rollout: { sessionId: "session-a", model: "gpt-6-sol", effort: "xhigh" },
      remembered: { sessionId: "session-a", model: null }, allowFreshUnknown: true,
    })],
    when: ["choosing Luna for that session", evidence => {
      const ctx = fixture({ sessionId: evidence.resumeSessionId, previous: evidence.previous,
        selected: { model: "gpt-6-luna", effort: "medium" },
        verify: async () => ({ model: "gpt-6-luna", effort: "medium" }) });
      return launchCodexWithPolicy(ctx).then(() => ({ evidence, events: ctx.events }));
    }],
    then: ["the old Sol session resumes only to compact before Luna starts", ({ evidence, events }) => {
      expect(evidence.resumeSessionId).toBe("session-a");
      expect(events).toEqual(["launch:gpt-6-sol", "compact", "reset", "launch:gpt-6-luna", "remember:gpt-6-luna"]);
    }],
  });
  component("a stopped session with no recorded model may start fresh without a model change", {
    given: ["the exact rollout and session record have no model", () => codexResumeEvidence({
      sessionId: "session-a", observed: { sessionId: "session-a", model: null },
      rollout: null, remembered: { sessionId: "session-a", model: null }, allowFreshUnknown: true,
    })],
    when: ["starting Luna", evidence => {
      const ctx = fixture({ sessionId: evidence.resumeSessionId, previous: evidence.previous,
        selected: { model: "gpt-6-luna", effort: "medium" },
        verify: async () => ({ model: "gpt-6-luna", effort: "medium" }) });
      return launchCodexWithPolicy(ctx).then(() => ({ evidence, events: ctx.events }));
    }],
    then: ["a new session starts without touching the unmodeled old session", ({ evidence, events }) => {
      expect(evidence.resumeSessionId).toBeNull();
      expect(events).toEqual(["launch:gpt-6-luna", "remember:gpt-6-luna"]);
    }],
  });
  component("resume observes Reserve instead of trusting an old Sol startup record", {
    given: ["same-session provider fallback since startup", () => codexResumeEvidence({
      sessionId: "session-a", remembered: {sessionId: "session-a", model: "gpt-5.6-sol"},
      observed: {sessionId: "session-a", model: "gpt-reserve"},
      maintenance: {sessionId: "session-a", status: "VERIFIED", cursor: {positions:{"/exact":42}}},
    })],
    then: ["latest model and existing receipt reach the launch policy", result => {
      expect(result.previous.model).toBe("gpt-reserve");
      expect(result.launchOptions.compactReceipt).toMatchObject({ok:true,sessionId:"session-a",compactBoundary:true});
    }],
  });
  component("a changed default compacts the old model before starting Sol", {
    given: ["a dormant Astra session selected for Sol", () => fixture()],
    when: ["waking its exact session", (ctx) => launchCodexWithPolicy(ctx)],
    then: ["compact precedes the new model and the choice is remembered", (_, ctx) => {
      expect(ctx.events).toEqual(["launch:gpt-6-astra", "compact", "reset", "launch:gpt-5.6-sol", "remember:gpt-5.6-sol"]);
    }],
  });
  component("failed compact leaves no model process able to receive work", {
    given: ["a compact refused by quota", () => fixture({ compact: async () => ({ ok: false, reason: "usage-limit" }) })],
    when: ["waking for a model change", (ctx) => launchCodexWithPolicy(ctx).catch(e => e.message)],
    then: ["the target model never starts and the failure persists", (error, ctx) => {
      expect(error).toContain("usage-limit");
      expect(ctx.events).toEqual(["launch:gpt-6-astra", "blocked", "reset"]);
    }],
  });
  component("a restart of the remembered model does not compact or switch again", {
    given: ["a session already on Sol", () => fixture({ previous: { model: "gpt-5.6-sol" } })],
    when: ["restarting", (ctx) => launchCodexWithPolicy(ctx)],
    then: ["only the existing selection starts", (_, ctx) => expect(ctx.events).toEqual(["launch:gpt-5.6-sol", "remember:gpt-5.6-sol"])],
  });
  component("a blocked automatic retry spends no further compact calls", {
    given: ["a persisted failed transition", () => fixture({ blocked: { target: "gpt-5.6-sol", reason: "usage-limit" } })],
    when: ["the delivery broker retries", (ctx) => launchCodexWithPolicy(ctx).catch(e => e.message)],
    then: ["no process or model call occurs", (error, ctx) => { expect(error).toContain("usage-limit"); expect(ctx.events).toEqual([]); }],
  });
  component("a fresh verified receipt avoids doing the same compact twice", {
    given: ["the explicit /model command already compacted this session", () => fixture({ receipt: { ok: true, sessionId: "session-a" } })],
    when: ["performing its restart", (ctx) => launchCodexWithPolicy(ctx)],
    then: ["the target starts using that receipt", (_, ctx) => expect(ctx.events).toEqual(["launch:gpt-5.6-sol", "remember:gpt-5.6-sol"])],
  });
  component("a late exact compact receipt releases the earlier failed transition without another model call", {
    given: ["compact completed after the earlier timeout", () => fixture({
      blocked: { target: "gpt-5.6-sol", reason: "compact-boundary-missing" },
      receipt: { ok: true, sessionId: "session-a" },
    })],
    when: ["a pending delivery retries after the new receipt", ctx => launchCodexWithPolicy(ctx)],
    then: ["only the requested model launches", (_, ctx) =>
      expect(ctx.events).toEqual(["launch:gpt-5.6-sol", "remember:gpt-5.6-sol"])],
  });
  component("another session's receipt cannot clear a failed transition", {
    given: ["the receipt does not name this session", () => fixture({
      blocked: { target: "gpt-5.6-sol", reason: "compact-boundary-missing" },
      receipt: { ok: true, sessionId: "other-session" },
    })],
    when: ["an automatic retry is attempted", ctx => launchCodexWithPolicy(ctx).catch(e => e.message)],
    then: ["nothing launches or spends compact quota", (error, ctx) => {
      expect(error).toContain("compact-boundary-missing"); expect(ctx.events).toEqual([]);
    }],
  });
});
