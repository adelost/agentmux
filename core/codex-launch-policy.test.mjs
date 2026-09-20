import { component, expect, feature } from "bdd-vitest";
import { launchCodexWithPolicy, codexResumeEvidence } from "./codex-launch-policy.mjs";

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
