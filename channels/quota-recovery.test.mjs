import { feature, component, unit, expect } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQuotaRecovery, parseQuotaRecoveryConfig } from "./quota-recovery.mjs";

const receipt = {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  limitEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  limitKind: "session",
  observedAt: Date.parse("2026-07-16T17:01:11.018Z"),
  resetAt: Date.parse("2026-07-16T18:50:00.000Z"),
};

function fixture({ usedPercent = 7 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-quota-recovery-"));
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, [
    "lsrc:",
    `  dir: ${root}`,
    "  panes:",
    "    - { name: broker, cmd: claude --continue }",
    "    - { name: worker, cmd: codex }",
    "  discord:",
    "    channel-1: 0",
    "native:",
    `  dir: ${root}`,
    "  backend: native",
    "  panes:",
    "    - { name: native-claude, cmd: claude }",
    "",
  ].join("\n"));
  const recoveries = [];
  const kicks = [];
  const messages = [];
  const queueJobs = new Map();
  const agent = {
    claudeLimitReceipt: async (name, pane) => name === "lsrc" && pane === 0 ? receipt : null,
  };
  const deliveryBroker = {
    queue: { read: (_name, _pane, id) => queueJobs.get(id) || null },
    recoverClaudeQuota: async (request) => {
      recoveries.push(request);
      const job = { id: "recovery-job", status: "pending" };
      queueJobs.set(job.id, { ...job, status: "acknowledged" });
      return { recovered: true, restarted: true, job };
    },
    kickTarget: async (...args) => { kicks.push(args); },
  };
  const recovery = createQuotaRecovery({
    agent,
    deliveryBroker,
    agentsYamlPath: configPath,
    discord: { send: async (...args) => { messages.push(args); } },
    config: { enabled: true, pollMs: 60_000, resetGraceMs: 15_000 },
    readQuota: async () => ({ ok: true, limits: [{ kind: "session", usedPercent }] }),
    now: () => Date.parse("2026-07-16T17:20:00.000Z"),
    log: () => {},
  });
  return { root, recovery, recoveries, kicks, messages };
}

feature("bridge-owned Claude quota recovery", () => {
  component("a top-up resumes only the exact limited tmux pane", {
    given: ["one Claude pane, one Codex pane, and one native Claude target", fixture],
    when: ["the fresh session quota shows capacity", ({ recovery }) => recovery.tick()],
    then: ["one exact receipt is recovered, drained, and reported", (results, ctx) => {
      expect(results).toHaveLength(1);
      expect(ctx.recoveries).toEqual([{ agentName: "lsrc", pane: 0, receipt }]);
      expect(ctx.kicks).toEqual([["lsrc", 0]]);
      expect(ctx.messages).toEqual([["channel-1",
        "✅ Kvoten är tillbaka. AMUX återstartade exakt samma Claude-session och fortsättningsturen är levererad."]]);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("an exhausted quota leaves the pane parked", {
    given: ["a still-exhausted session", () => fixture({ usedPercent: 100 })],
    when: ["the poll runs before reset", ({ recovery }) => recovery.tick()],
    then: ["no restart, delivery, or success notice occurs", (results, ctx) => {
      expect(results[0].readiness).toMatchObject({ ready: false, reason: "session-limit-still-exhausted" });
      expect(ctx.recoveries).toEqual([]);
      expect(ctx.kicks).toEqual([]);
      expect(ctx.messages).toEqual([]);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("overlapping polls share one recovery flight", {
    given: ["a quota read held open", () => {
      const ctx = fixture();
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const original = ctx.recovery;
      // Build a second controller over the same broker with a delayed quota
      // read so two timer ticks overlap deterministically.
      ctx.recovery = createQuotaRecovery({
        agent: { claudeLimitReceipt: async () => receipt },
        deliveryBroker: {
          queue: { read: () => ({ status: "acknowledged" }) },
          recoverClaudeQuota: async (request) => {
            ctx.recoveries.push(request);
            return { recovered: true, restarted: true, job: { id: "job" } };
          },
          kickTarget: async () => {},
        },
        agentsYamlPath: join(ctx.root, "agents.yaml"),
        config: { enabled: true, pollMs: 60_000, resetGraceMs: 15_000 },
        readQuota: async () => { await gate; return { ok: true, limits: [{ kind: "session", usedPercent: 7 }] }; },
        log: () => {},
      });
      return { ...ctx, original, release };
    }],
    when: ["two ticks arrive before the quota response", async (ctx) => {
      const first = ctx.recovery.tick();
      const second = ctx.recovery.tick();
      expect(second).toBe(first);
      ctx.release();
      await Promise.all([first, second]);
    }],
    then: ["the exact limit event starts one recovery", (_, ctx) => {
      expect(ctx.recoveries).toHaveLength(1);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  unit("the automatic guard is enabled by default and tunable", {
    when: ["parsing an empty and an explicit environment", () => ({
      defaults: parseQuotaRecoveryConfig({}),
      custom: parseQuotaRecoveryConfig({
        AMUX_QUOTA_RECOVERY_ENABLED: "false",
        AMUX_QUOTA_RECOVERY_POLL_MS: "5000",
        AMUX_QUOTA_RECOVERY_RESET_GRACE_MS: "30000",
      }),
    })],
    then: ["safe production defaults and the kill-switch are stable", ({ defaults, custom }) => {
      expect(defaults).toEqual({ enabled: true, pollMs: 30_000, resetGraceMs: 15_000 });
      expect(custom).toEqual({ enabled: false, pollMs: 5_000, resetGraceMs: 30_000 });
    }],
  });
});
