import { afterEach, beforeEach, vi } from "vitest";
import { feature, component, expect } from "bdd-vitest";

const context = vi.hoisted(() => ({ options: null, calls: [], starts: 0 }));
vi.mock("../lib.mjs", () => ({ parseEnv: () => ({}) }));
vi.mock("../core/state.mjs", () => ({ createState: () => ({ get: (_key, fallback) => fallback }) }));
vi.mock("../core/delivery-queue.mjs", () => ({ createDeliveryQueue: () => ({}) }));
vi.mock("../core/claude-quota-lifecycle.mjs", () => ({ createClaudeQuotaLifecycle: () => ({
  profileFor: (_agentName, pane) => ({ id: String(pane + 1), key: `claude:${pane + 1}`, credentialsPath: `/synthetic/${pane}/credentials.json` }),
}) }));
vi.mock("../core/claude-quota-budget.mjs", () => ({ readClaudeQuotaBudgeted: async options => {
  context.calls.push(options);
  return options?.profile?.credentialsPath
    ? { ok: true, profile: { key: options.profile.key }, limits: [{ kind: "weekly_all", usedPercent: options.profile.id === "1" ? 0 : 100 }] }
    : { ok: false, error: "credentials_unavailable" };
} }));
vi.mock("../core/claude-quota-coordinator.mjs", () => ({ createClaudeQuotaCoordinator: options => {
  context.options = options; return {};
} }));
vi.mock("../channels/quota-recovery.mjs", () => ({
  parseQuotaRecoveryConfig: () => ({ enabled: true }),
  createQuotaRecoveryLoop: () => ({ start: () => { context.starts++; } }),
}));

beforeEach(() => {
  vi.resetModules(); context.calls = []; context.options = null; context.starts = 0;
  delete globalThis[Symbol.for("agentmux.quotaRecoveryLoop")];
});
afterEach(() => { delete globalThis[Symbol.for("agentmux.quotaRecoveryLoop")]; });

feature("the installed quota recovery preload", () => {
  component("passes the target profile instead of probing an undefined credential path", {
    when: ["the real bootstrap collects a target's quota", async () => {
      await import("./quota-recovery-bootstrap.mjs");
      return context.options.readQuota({ agentName: "lsrc", pane: 0, receipt: { observedAt: 1_000 } });
    }],
    then: ["the available subscription reaches readiness without a provider call", result => {
      expect(result).toMatchObject({ ok: true, profile: { key: "claude:1" } });
      expect(context.calls[0].profile.credentialsPath).toBe("/synthetic/0/credentials.json");
      expect(context.calls[0].notBefore).toBe(1_000);
      expect(context.starts).toBe(1);
    }],
  });

  component("does not lend the primary account's capacity to another selected profile", {
    when: ["the bootstrap collects two different targets", async () => {
      await import("./quota-recovery-bootstrap.mjs");
      return Promise.all([0, 1].map(pane => context.options.readQuota({ agentName: "lsrc", pane })));
    }],
    then: ["each target gets only its own account's usage", ([available, spent]) => {
      expect(available).toMatchObject({ ok: true, profile: { key: "claude:1" }, limits: [{ usedPercent: 0 }] });
      expect(spent).toMatchObject({ ok: true, profile: { key: "claude:2" }, limits: [{ usedPercent: 100 }] });
    }],
  });
});
