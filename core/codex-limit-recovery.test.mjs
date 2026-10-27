import { feature, component, expect } from "bdd-vitest";
import { createCodexLimitRecovery } from "./codex-limit-recovery.mjs";

function fixture({ continuity = true, sourceUsed = 100, sessionUsed = null, otherUsed = 0, enabled = true, handover = false, currentId = "1" } = {}) {
  const data = {}, sent = [], switched = [], notices = [];
  const state = { get: (key, fallback = {}) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  data.codex_profile_by_pane = { "lsrc:5": currentId };
  let jobs = [];
  const broker = { queue: { list: () => jobs, acquireSessionLease: () => ({ release() {} }) },
    enqueue: job => { sent.push(job); return { id: "j1" }; }, runExclusive: (_name, _pane, work) => work() };
  const agent = { promptTransportState: async () => ({ dialect: "codex", busy: false, state: "empty-idle" }), captureScreen: async () => "› " };
  const result = { jsonlFile: "/x/rollout-019f5181-95b3-7e72-978b-1e74a246a86a.jsonl", lastPrompt: null,
    refusals: [{ id: "limit-1", timestamp: "2026-10-12T07:10:00Z", reason: "You've hit your usage limit. Try again later." }] };
  const readQuota = async profile => ({ ok: true, account: { email: "test@example.com" }, limits: [{ limitId: "codex",
    windows: [{ windowMinutes: 10080, usedPercent: profile.id === currentId ? sourceUsed : otherUsed },
      ...(sessionUsed === null ? [] : [{ windowMinutes: 300, usedPercent: profile.id === currentId ? sessionUsed : 0 }])] }] });
  const recovery = createCodexLimitRecovery({ state, broker, agent, enabled,
    catalog: [{ id: "1", home: "/one" }, { id: "2", home: "/two" }],
    authenticated: () => true,
    quota: readQuota, deliveryQuota: readQuota,
    continuity: () => ({ ok: continuity, sessionId: "same-session", reason: "session unavailable" }),
    transferSession: () => ({ ok: continuity, sessionId: "same-session", reason: "session unavailable" }),
    prepareHandover: () => ({ ok: handover, path: "/handover.json", text: "exact task and reply", reason: "no verified handover" }),
    freshAccount: async args => args.handover.ok ? { kind: "switched", fresh: true, text: args.handover.text,
      path: "/new-rollout.jsonl", handoverPath: args.handover.path } : { kind: "failed", error: "no verified handover" },
    readLatestPrompt: () => null,
    switchAccount: async args => { switched.push(args); return { kind: "switched" }; },
    notify: async message => { notices.push(message); }, log: () => {} });
  return { result, sent, switched, notices, agent, setJobs: value => { jobs = value; },
    admit: job => recovery.beforeDelivery(job, { dir: "/pane", lease: {} }),
    run: () => recovery.tick({ name: "lsrc", pane: 5, dir: "/pane", result }) };
}

feature("automatic Codex account recovery only after a reached weekly limit", () => {
  component("new input leaves an exhausted account before delivery without a paid compact", {
    given: ["account2 is full, account1 has room and the broker owns one unsent job", () => fixture({ currentId: "2", otherUsed: 24 })],
    when: ["admitting the original delivery under its existing lease", async fx => {
      const job = { id: "original", agentName: "lsrc", pane: 5, kind: "prompt", status: "delivering" };
      fx.setJobs([job]); return { fx, result: await fx.admit(job) };
    }],
    then: ["the same session switches once without adding a duplicate prompt", ({ fx, result }) => {
      expect(result).toEqual({ ok: true });
      expect(fx.switched[0]).toMatchObject({ current: { id: "2" }, target: { id: "1" }, continuity: { sessionId: "same-session" } });
      expect(fx.sent).toHaveLength(0);
    }],
  });
  component("an unresolved submitted job prevents pre-delivery account switching", {
    given: ["a full account but an older post-submit fence", () => fixture({ currentId: "2" })],
    when: ["a later delivery asks for admission", async fx => {
      fx.setJobs([{ id: "old", status: "submitted" }]);
      return { fx, result: await fx.admit({ id: "new", agentName: "lsrc", pane: 5, kind: "prompt" }) };
    }],
    then: ["the old receipt fence remains intact and the account is not changed", ({ fx, result }) => {
      expect(result.ok).toBe(false); expect(fx.switched).toHaveLength(0);
    }],
  });
  for (const [label, options] of [["forecast", { sourceUsed: 99 }], ["disabled recovery", { enabled: false }]]) component(`${label} does not switch before delivery`, {
    given: ["no authorized reached-limit switch", () => fixture(options)],
    when: ["admitting new input", async fx => { await fx.admit({ id: "new", agentName: "lsrc", pane: 5, kind: "prompt" }); return fx; }],
    then: ["no switch or extra prompt", fx => { expect(fx.switched).toHaveLength(0); expect(fx.sent).toHaveLength(0); }],
  });
  component("temporary model capacity never switches accounts", {
    given: ["a capacity refusal even though the weekly counter is full", () => fixture()],
    when: ["observing that refusal", async fx => {
      fx.result.refusals[0].reason = "Selected model is at capacity. Please try a different model.";
      await fx.run(); return fx;
    }],
    then: ["capacity stays on the same account", fx => expect(fx.switched).toHaveLength(0)],
  });
  component("account2 returns to account1 only at its actual reached weekly limit", {
    given: ["Codex2 is selected and its real weekly quota is exhausted", () => fixture({ currentId: "2", sourceUsed: 100, otherUsed: 15 })],
    when: ["observing the provider refusal", async fx => { await fx.run(); return fx; }],
    then: ["the same guarded switch targets1 with one continuation", fx => {
      expect(fx.switched[0]).toMatchObject({ current: { id: "2" }, target: { id: "1" } });
      expect(fx.sent).toHaveLength(1);
    }],
  });
  // api:0 for lsrc:0, 2026-10-27: a spent 5 h window moves the pane to an account with room, as a spent week does.
  component("a refusal at a spent 5 h window moves the pane like a spent week", {
    given: ["the 5 h window reads 100 % with 72 % of the week used, and a spare account", () => fixture({ sourceUsed: 72, sessionUsed: 100 })],
    when: ["observing the provider refusal", async fx => { await fx.run(); return fx; }],
    then: ["the guarded switch runs once with one continuation", fx => {
      expect(fx.switched).toHaveLength(1);
      expect(fx.switched[0]).toMatchObject({ current: { id: "1" }, target: { id: "2" } });
      expect(fx.sent).toHaveLength(1);
    }],
  });
  component("a nonportable session gets one saved fresh-session handover", {
    given: ["reached limit, spare account and durable exact task evidence", () => fixture({ continuity: false, handover: true })],
    when: ["observing the refusal twice", async fx => { await fx.run(); await fx.run(); return fx; }],
    then: ["one handover replaces capacity continuation without replaying the original input", fx => {
      expect(fx.sent).toHaveLength(1); expect(fx.sent[0].text).toBe("exact task and reply");
      expect(fx.sent[0].metadata.handoverPath).toBe("/handover.json"); expect(fx.notices).toHaveLength(0);
    }],
  });
  component("one reached limit switches once with continuity and queues one continuation", {
    given: ["a real limit and a spare authenticated account", fixture],
    when: ["observing the same refusal twice", async fx => { await fx.run(); await fx.run(); return fx; }],
    then: ["one account switch and one continuation", fx => { expect(fx.switched).toHaveLength(1); expect(fx.sent).toHaveLength(1); }],
  });
  for (const [name, options] of [["forecast only", { sourceUsed: 90 }], ["other account full", { otherUsed: 100 }],
    ["continuity blocked", { continuity: false }], ["disabled", { enabled: false }]]) {
    component(`${name} never switches`, {
      given: ["the bounded refusal scenario", () => fixture(options)],
      when: ["observing twice", async fx => { await fx.run(); await fx.run(); return fx; }],
      then: ["no switch or continuation, continuity blocker notified once", fx => {
        expect(fx.switched).toHaveLength(0); expect(fx.sent).toHaveLength(0);
        if (name === "continuity blocked") expect(fx.notices).toHaveLength(1);
      }],
    });
  }
});
