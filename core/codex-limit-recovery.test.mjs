import { feature, component, expect } from "bdd-vitest";
import { createCodexLimitRecovery } from "./codex-limit-recovery.mjs";

function fixture({ continuity = true, sourceUsed = 100, otherUsed = 0, enabled = true } = {}) {
  const data = {}, sent = [], switched = [], notices = [];
  const state = { get: (key, fallback = {}) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  const broker = { queue: { list: () => [], acquireSessionLease: () => ({ release() {} }) },
    enqueue: job => { sent.push(job); return { id: "j1" }; }, runExclusive: (_name, _pane, work) => work() };
  const agent = { promptTransportState: async () => ({ dialect: "codex", busy: false, state: "empty-idle" }), captureScreen: async () => "› " };
  const result = { jsonlFile: "/x/rollout-019f5181-95b3-7e72-978b-1e74a246a86a.jsonl", lastPrompt: null,
    refusals: [{ id: "limit-1", timestamp: "2026-10-12T07:10:00Z", reason: "You've hit your usage limit. Try again later." }] };
  const recovery = createCodexLimitRecovery({ state, broker, agent, enabled,
    catalog: [{ id: "1", home: "/one" }, { id: "2", home: "/two" }],
    authenticated: () => true,
    quota: async profile => ({ ok: true, account: { email: "test@example.com" }, limits: [{ limitId: "codex",
      windows: [{ windowMinutes: 10080, usedPercent: profile.id === "1" ? sourceUsed : otherUsed }] }] }),
    continuity: () => ({ ok: continuity, sessionId: "same-session", reason: "session unavailable" }),
    readLatestPrompt: () => null,
    switchAccount: async args => { switched.push(args); return { kind: "switched" }; },
    notify: async message => { notices.push(message); }, log: () => {} });
  return { result, sent, switched, notices, run: () => recovery.tick({ name: "lsrc", pane: 5, dir: "/pane", result }) };
}

feature("automatic Codex account recovery only after a reached weekly limit", () => {
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
