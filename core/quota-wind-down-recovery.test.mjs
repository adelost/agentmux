import { feature, component, expect } from "bdd-vitest";
import { afterAll, beforeAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createClaudeQuotaCoordinator } from "./claude-quota-coordinator.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";
import { captureJsonlAppendCursor } from "./jsonl-append-cursor.mjs";
import { rememberContextCompact } from "./context-maintenance.mjs";
import { windDownContinuation } from "./quota-wind-down.mjs";
import { composerAgent } from "../test/fixtures/composer-agent.mjs";

const PAUSED = Number.MAX_SAFE_INTEGER;
function world({ restart = "ok" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-wind-down-recovery-"));
  const cwd = join(root, ".agents", "0"), configPath = join(root, "agents.yaml");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(configPath, `test:\n  dir: ${root}\n  panes:\n    - { cmd: claude }\n`);
  const identity = { sessionId: "synthetic-session", path: join(cwd, "session.jsonl") };
  writeFileSync(identity.path, "{}\n");
  let now = Date.now() + 1000, liveKey = "claude:1", selectedKey = liveKey, restarted = 0, intentAtSelect = null;
  const data = {}, state = { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  rememberContextCompact(state, "test", 0, { ok: true, sessionId: identity.sessionId,
    cursor: captureJsonlAppendCursor("context-maintenance-v1", [identity.path]) });
  const profiles = [{ id: "1", key: "claude:1" }, { id: "2", key: "claude:2" }];
  const queueOptions = { rootDir: join(root, "queue"), now: () => now };
  const queue = createDeliveryQueue(queueOptions), { agent, pane } = composerAgent();
  const text = windDownContinuation({ from: "Claude S", to: "Claude A" });
  const input = { agentName: "test", pane: 0, beganAt: now - 2000,
    episode: `test:0|session|${now + 60_000}`, from: { name: "Claude S", key: "claude:1" },
    target: { name: "Claude A", profileId: "2", profileKeys: ["claude:2"] } };
  const lifecycle = { activeReceipt: () => null, profileFor: () => profiles.find(profile => profile.key === selectedKey),
    selectProfile: (_name, _pane, profile) => { intentAtSelect = queue.list("test", 0)[0]; selectedKey = profile.key; },
    recoveredSession: async (_name, _pane, sessionId, profileKey) => ({ ok: sessionId === identity.sessionId && liveKey === profileKey }),
    liveProfileIs: async (_name, _pane, profileKey) => liveKey === profileKey,
    restartAfterWindDown: async () => {
      restarted++;
      if (restart === "fail") return { ok: false, reason: "synthetic-restart-refusal" };
      liveKey = selectedKey;
      if (restart === "cut") throw new Error("synthetic bridge cut after restart");
      return { ok: true, sessionId: identity.sessionId };
    } };
  const windDown = { state, agent, identityFor: () => identity, profiles: () => profiles,
    readTargetQuota: async () => ({ ok: true, provider: "claude", name: "Claude A", profile: profiles[1],
      observation: { observedAt: new Date(now - 1).toISOString() }, limits: [
        { kind: "session", usedPercent: 10, resetsAt: new Date(now + 3_600_000).toISOString() },
        { kind: "weekly_all", usedPercent: 40, resetsAt: new Date(now + 86_400_000).toISOString() }] }) };
  const coordinator = (freshQueue = queue, options = { windDown }) => createClaudeQuotaCoordinator({ queue: freshQueue,
    lifecycle, configPath, readQuota: async () => null, now: () => now, log: () => {}, ...options });
  const broker = freshQueue => createDeliveryBroker({ queue: freshQueue, agent, now: () => now, notify: async () => {} });
  return { queue, input, text, pane, coordinator, broker, restarted: () => restarted, intentAtSelect: () => intentAtSelect,
    advance: ms => { now += ms; }, freshQueue: () => createDeliveryQueue(queueOptions),
    pausedIntent: () => {
      const job = queue.enqueue({ agentName: "test", pane: 0, source: "quota-wind-down", text,
        idempotencyKey: `quota-wind-down:moved:test:0:${input.episode}`, orderKey: "0000000000000000:wind-down",
        metadata: { windDownSessionId: identity.sessionId, windDownTargetProfileKey: "claude:2",
          windDownSourceProfileKey: "claude:1", windDownResetAt: Number(input.episode.split("|").at(-1)) } });
      return queue.update(job, { nextAttemptAt: PAUSED });
    }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("R-8 durable wind-down continuation (component)", () => {
  beforeAll(() => { vi.stubEnv("AMUX_QUOTA_WIND_DOWN", "on"); });
  afterAll(() => { vi.unstubAllEnvs(); });
  component("a continuation is born paused in the durable queue", {
    given: ["a move intent before any process effects", () => world()],
    when: ["publishing the initial job and opening a separate queue reader", ctx => {
      const job = ctx.queue.enqueue({ agentName: "test", pane: 0, text: ctx.text, nextAttemptAt: PAUSED });
      return ctx.freshQueue().read("test", 0, job.id);
    }],
    then: ["another process never observes a deliverable initial job", (job, ctx) => {
      try { expect(job).toMatchObject({ status: "pending", nextAttemptAt: PAUSED }); }
      finally { ctx.cleanup(); }
    }],
  });
  component("the first FIFO job is durably paused before account selection", {
    given: ["a verified move and an ordinary follower", () => {
      const ctx = world(); ctx.queue.enqueue({ agentName: "test", pane: 0, text: "follower" }); return ctx;
    }],
    when: ["moving the exact session", ctx => ctx.coordinator().moveAfterWindDown(ctx.input)],
    then: ["selection observes a paused intent with the recovery facts", (result, ctx) => {
      try {
        expect(result.moved).toBe(true);
        expect(ctx.intentAtSelect()).toMatchObject({ text: ctx.text, status: "pending", nextAttemptAt: PAUSED,
          metadata: { windDownSessionId: "synthetic-session", windDownTargetProfileKey: "claude:2",
            windDownResetAt: Number(ctx.input.episode.split("|").at(-1)) } });
      } finally { ctx.cleanup(); }
    }],
  });
  component("a move cut after restart delivers MOVED exactly once after a fresh poll", {
    given: ["a verified compact whose process restart succeeds before the bridge disappears", () => world({ restart: "cut" })],
    when: ["moving, replacing the coordinator and broker, then polling twice", async ctx => {
      await ctx.coordinator().moveAfterWindDown(ctx.input);
      const queue = ctx.freshQueue(), recovered = ctx.coordinator(queue, {}), broker = ctx.broker(queue);
      await recovered.tick(); await broker.kickTarget("test", 0);
      await recovered.tick(); await broker.kickTarget("test", 0);
    }],
    then: ["the saved session receives one continuation without another restart", (_result, ctx) => {
      try { expect(ctx.pane.submitted).toEqual([ctx.text]); expect(ctx.restarted()).toBe(1); }
      finally { ctx.cleanup(); }
    }],
  });
  component("after a failed restart an ordinary job still delivers behind the saved intent", {
    given: ["a paused move intent left by a previous bridge and an ordinary follower", () => {
      const ctx = world({ restart: "fail" });
      ctx.pausedIntent();
      ctx.queue.enqueue({ agentName: "test", pane: 0, source: "cli", text: "ordinary follower" });
      return ctx;
    }],
    when: ["retrying the move and draining the broker", async ctx => {
      const result = await ctx.coordinator().moveAfterWindDown(ctx.input);
      await ctx.broker(ctx.queue).kickTarget("test", 0);
      return result;
    }],
    then: ["the failed intent is not a successful replay and cannot block ordinary work", (result, ctx) => {
      try { expect(ctx.pane.submitted).toEqual(["ordinary follower"]); expect(result.moved).toBe(false); }
      finally { ctx.cleanup(); }
    }],
  });
  component("a retry after a lost restart receipt reuses the intent without another restart", {
    given: ["an exact restart cut before releasing its intent", async () => {
      const ctx = world({ restart: "cut" }); await ctx.coordinator().moveAfterWindDown(ctx.input); return ctx;
    }],
    when: ["retrying the same move with a fresh instance", ctx => ctx.coordinator().moveAfterWindDown(ctx.input)],
    then: ["live target proof releases the original job instead of restarting again", (result, ctx) => {
      try {
        expect(ctx.restarted()).toBe(1);
        expect(result).toMatchObject({ moved: true, replayed: true });
        expect(ctx.queue.list("test", 0)).toHaveLength(1);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a paused continuation whose episode ended on source is cancelled and never delivered", {
    given: ["a durable paused intent whose source session never moved before reset", () => {
      const ctx = world(); ctx.intent = ctx.pausedIntent(); ctx.advance(61_000); return ctx;
    }],
    when: ["a fresh coordinator polls and the broker drains", async ctx => {
      const queue = ctx.freshQueue();
      await ctx.coordinator(queue, {}).tick(); await ctx.broker(queue).kickTarget("test", 0);
    }],
    then: ["the stale intent is cancelled, not presented as MOVED", (_result, ctx) => {
      try {
        expect(ctx.queue.read("test", 0, ctx.intent.id).status).toBe("cancelled");
        expect(ctx.pane.submitted).toEqual([]); expect(ctx.restarted()).toBe(0);
      } finally { ctx.cleanup(); }
    }],
  });
});
