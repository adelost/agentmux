import { feature, component, expect } from "bdd-vitest";
import { afterAll, beforeAll, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createClaudeQuotaCoordinator } from "./claude-quota-coordinator.mjs";
import { isClaudeQuotaContinuationAuthorized } from "./claude-quota-target.mjs";
import { quotaRecoveryContinuation } from "./claude-quota-recovery.mjs";
import { captureJsonlAppendCursor } from "./jsonl-append-cursor.mjs";
import { quotaParkContinuation } from "./quota-park.mjs";

function windDownFixture({ verified = true, busy = false, draft = false, sessionUsed = 10 } = {}) {
  const data = {}, state = { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
  const identity = { sessionId: receipt.sessionId }, profiles = [{ id: "1", key: "claude:1" }, { id: "2", key: "claude:2" }];
  const targetQuota = { ok: true, provider: "claude", name: "Claude A", profile: profiles[1],
    observation: { observedAt: new Date(25_000).toISOString() }, limits: [
      { kind: "weekly_all", usedPercent: 40, resetsAt: new Date(1e9).toISOString() },
      { kind: "session", usedPercent: sessionUsed, resetsAt: new Date(1e7).toISOString() }] };
  const agent = { paneProcessState: async () => ({ running: true, command: "claude" }), isBusy: async () => busy,
    promptTransportState: async () => ({ state: draft ? "drafted" : "empty-idle" }) };
  const ctx = fixture({ coordinatorOptions: { windDown: { state, agent, identityFor: () => identity, profiles: () => profiles,
    readTargetQuota: async () => targetQuota } } });
  identity.path = join(ctx.cwd, "wind-down.jsonl");
  writeFileSync(identity.path, "{}\n");
  const compact = { status: verified ? "VERIFIED" : "FAILED", sessionId: identity.sessionId, at: 15_000, finishedAt: 20_000,
    cursor: captureJsonlAppendCursor("context-maintenance-v1", [identity.path]) };
  state.set("context_maintenance_by_pane_v1", { "lsrc:0": compact });
  let selected = profiles[0];
  ctx.lifecycle.profileFor = () => selected;
  ctx.lifecycle.selectProfile = (_name, _pane, profile) => { selected = profile; };
  ctx.lifecycle.restartAfterWindDown = async (...args) => {
    ctx.restarts.push(args);
    return { ok: true, sessionId: identity.sessionId };
  };
  ctx.setActiveReceipt(null);
  return { ...ctx, state, compact, identity, targetQuota, selected: () => selected,
    input: { agentName: "lsrc", pane: 0, target: { name: "Claude A", profileId: "2", profileKeys: ["claude:2"] },
      from: { name: "Claude S", key: "claude:1" }, episode: "lsrc:0|session|10000000", beganAt: 10_000 } };
}

feature("verified quota wind-down moves (component)", () => {
  // These cases exercise moves, which run only with wind-down on; the shipped default is dry (design §11).
  beforeAll(() => { vi.stubEnv("AMUX_QUOTA_WIND_DOWN", "on"); });
  afterAll(() => { vi.unstubAllEnvs(); });
  for (const unsafe of ["other-session", "before-episode", "new-work", "live-delivery", "stale-target", "session-lease"]) {
    component(`I-2 refuses ${unsafe}`, {
      given: ["one missing move invariant", () => {
        const ctx = windDownFixture();
        if (unsafe === "other-session") ctx.compact.sessionId = "other-session";
        if (unsafe === "before-episode") { ctx.compact.at = 1000; ctx.compact.finishedAt = 2000; }
        if (unsafe === "new-work") appendFileSync(ctx.identity.path, JSON.stringify({ type: "user", message: { content: "new task" } }) + "\n");
        if (unsafe === "stale-target") ctx.targetQuota.observation.observedAt = new Date(19_000).toISOString();
        if (unsafe === "live-delivery") {
          const job = ctx.queue.enqueue({ agentName: "lsrc", pane: 0, text: "synthetic in-flight delivery" });
          ctx.queue.update(job, { status: "submitted", submittedAt: 29_000 });
        }
        if (unsafe === "session-lease") ctx.heldLease = ctx.queue.acquireSessionLease("lsrc", 0);
        return ctx;
      }],
      when: ["trying the move", ctx => ctx.coordinator.moveAfterWindDown(ctx.input)],
      then: ["no account selection or process restart", (result, ctx) => {
        try { expect(result.moved).toBe(false); expect(ctx.selected().key).toBe("claude:1"); expect(ctx.restarts).toEqual([]); }
        finally { ctx.heldLease?.release(); ctx.cleanup(); }
      }],
    });
  }
  component("moves an idle, compacted pane to the account with room", {
    given: ["UC-4, verified compact in this episode and fresh room in both windows", () => windDownFixture()],
    when: ["moving twice across the same boundary", async ctx => [await ctx.coordinator.moveAfterWindDown(ctx.input), await ctx.coordinator.moveAfterWindDown(ctx.input)]],
    then: ["one exact restart, one MOVED continuation and target selected", ([first, again], ctx) => {
      try {
        expect(first.moved).toBe(true); expect(again.moved).toBe(true);
        expect(ctx.selected().key).toBe("claude:2"); expect(ctx.restarts).toHaveLength(1);
        expect(ctx.restarts[0][2].sessionId).toBe(receipt.sessionId);
        const jobs = ctx.queue.list("lsrc", 0);
        expect(jobs).toHaveLength(1); expect(jobs[0].text).toContain("[AMUX QUOTA WIND-DOWN · MOVED]");
      } finally { ctx.cleanup(); }
    }],
  });
  for (const unsafe of ["busy", "draft"]) {
    component(`no move while ${unsafe}`, {
      given: ["R-7, verified compact but unsafe input", () => windDownFixture({ [unsafe]: true })],
      when: ["trying the move", ctx => ctx.coordinator.moveAfterWindDown(ctx.input)],
      then: ["no selection, restart or continuation", (result, ctx) => {
        try { expect(result.moved).toBe(false); expect(ctx.selected().key).toBe("claude:1"); expect(ctx.restarts).toEqual([]); expect(ctx.queue.list("lsrc", 0)).toEqual([]); }
        finally { ctx.cleanup(); }
      }],
    });
  }
  component("no move without a verified compact", {
    given: ["I-2, a failed compact", () => windDownFixture({ verified: false })],
    when: ["trying the move", ctx => ctx.coordinator.moveAfterWindDown(ctx.input)],
    then: ["the pane stays put", (result, ctx) => {
      try { expect(result).toMatchObject({ moved: false, reason: "wind-down-compact-unverified" }); expect(ctx.restarts).toEqual([]); }
      finally { ctx.cleanup(); }
    }],
  });
  component("a target that lost session room is rechecked before selection", {
    given: ["a target now at 90 % session use", () => windDownFixture({ sessionUsed: 90 })],
    when: ["trying the move", ctx => ctx.coordinator.moveAfterWindDown(ctx.input)],
    then: ["no move", (result, ctx) => {
      try { expect(result.moved).toBe(false); expect(ctx.selected().key).toBe("claude:1"); expect(ctx.restarts).toEqual([]); }
      finally { ctx.cleanup(); }
    }],
  });
});

const receipt = {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  limitEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  limitKind: "session",
  observedAt: 1_000,
  resetAt: 20_000,
};

function fixture({
  readQuota = async () => ({ ok: true, limits: [{ kind: "session", usedPercent: 7 }] }),
  coordinatorOptions = {},
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-quota-coordinator-"));
  const repoDir = join(root, "repo");
  const cwd = join(repoDir, ".agents", "0");
  const configPath = join(root, "agents.yaml");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(configPath, [
    "lsrc:",
    `  dir: ${repoDir}`,
    "  panes:",
    "    - { name: broker, cmd: claude }",
    "",
  ].join("\n"));
  let clock = 30_000;
  let activeReceipt = receipt;
  const restarts = [];
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => clock });
  const lifecycle = {
    activeReceipt: () => activeReceipt,
    recoveredSession: async () => ({ ok: true, sessionId: receipt.sessionId }),
    restart: async (...args) => {
      restarts.push(args);
      return { ok: true, sessionId: receipt.sessionId };
    },
  };
  const coordinator = createClaudeQuotaCoordinator({
    queue,
    lifecycle,
    configPath,
    readQuota,
    now: () => clock,
    log: () => {},
    ...coordinatorOptions,
  });
  return {
    root, cwd, configPath, queue, lifecycle, coordinator, restarts,
    setActiveReceipt: (next) => { activeReceipt = next; },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

feature("durable quota parking", () => {
  component("a limited target parks its FIFO without changing delivery truth", {
    given: ["one pending prompt and an exact receipt", () => {
      const ctx = fixture();
      ctx.job = ctx.queue.enqueue({ agentName: "lsrc", pane: 0, text: "queued while limited" });
      return ctx;
    }],
    when: ["the sidecar fences the target", (ctx) => ctx.coordinator.parkTarget("lsrc", 0, receipt, ctx.cwd)],
    then: ["the payload stays pending but cannot be selected before recovery", (result, ctx) => {
      expect(result).toEqual({ parked: true, count: 1 });
      expect(ctx.queue.read("lsrc", 0, ctx.job.id)).toMatchObject({
        status: "pending",
        nextAttemptAt: Number.MAX_SAFE_INTEGER,
        metadata: {
          quotaPreviousStatus: "pending",
          quotaLimitEventId: receipt.limitEventId,
          quotaSessionId: receipt.sessionId,
        },
      });
      ctx.cleanup();
    }],
  });

  component("recovery restarts once and puts continuation before old work", {
    given: ["an ambiguous submitted job", () => {
      const ctx = fixture();
      const created = ctx.queue.enqueue({ agentName: "lsrc", pane: 0, text: "queued while limited" });
      ctx.job = ctx.queue.update(created, {
        status: "submitted",
        submitFenceAt: 25_000,
        submittedAt: 25_000,
      });
      return ctx;
    }],
    when: ["the same poll is replayed after successful restart", async (ctx) => ({
      first: await ctx.coordinator.recoverTarget("lsrc", 0, receipt, ctx.cwd),
      retry: await ctx.coordinator.recoverTarget("lsrc", 0, receipt, ctx.cwd),
    })],
    then: ["one exact restart safely reopens the old fence and reserves one continuation", ({ first, retry }, ctx) => {
      expect(first).toMatchObject({ recovered: true, restarted: true, replayed: false });
      expect(retry).toMatchObject({ recovered: true, restarted: false, replayed: true });
      expect(ctx.restarts).toEqual([["lsrc", 0, receipt]]);
      const jobs = ctx.queue.list("lsrc", 0);
      expect(jobs).toHaveLength(2);
      expect(jobs[0]).toMatchObject({ source: "quota-recovery", status: "pending" });
      expect(isClaudeQuotaContinuationAuthorized(
        "lsrc", 0, receipt, quotaRecoveryContinuation(), { queue: ctx.queue },
      )).toBe(true);
      expect(jobs[1]).toMatchObject({
        id: ctx.job.id,
        status: "pending",
        submitFenceAt: null,
        submittedAt: null,
        metadata: { quotaRecoveredAt: 30_000 },
      });
      ctx.cleanup();
    }],
  });

  component("superseded evidence cannot mutate the queue or restart", {
    given: ["a newer limit event now owns the pane", () => {
      const ctx = fixture();
      ctx.job = ctx.queue.enqueue({ agentName: "lsrc", pane: 0, text: "leave me alone" });
      ctx.setActiveReceipt({ ...receipt, limitEventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" });
      return ctx;
    }],
    when: ["stale recovery arrives", (ctx) => ctx.coordinator.recoverTarget("lsrc", 0, receipt, ctx.cwd)],
    then: ["nothing is restarted or reordered", (result, ctx) => {
      expect(result).toEqual({ recovered: false, reason: "limit-receipt-superseded" });
      expect(ctx.restarts).toEqual([]);
      expect(ctx.queue.list("lsrc", 0)).toHaveLength(1);
      expect(ctx.queue.read("lsrc", 0, ctx.job.id).nextAttemptAt).toBe(30_000);
      ctx.cleanup();
    }],
  });
});

feature("quota polling", () => {
  component("one account is collected once per poll while each pane keeps its own restart boundary", {
    given: ["two limited panes on the same selected profile", () => {
      let reads = 0;
      const ctx = fixture({ readQuota: async () => {
        reads++;
        return { ok: true, profile: { key: "claude:1" }, limits: [{ kind: "weekly_all", usedPercent: 0 }] };
      } });
      writeFileSync(ctx.configPath, ["lsrc:", `  dir: ${join(ctx.cwd, "../..")}`, "  panes:",
        "    - { name: first, cmd: claude }", "    - { name: second, cmd: claude }", ""].join("\n"));
      ctx.lifecycle.profileFor = () => ({ key: "claude:1" });
      ctx.readCount = () => reads;
      return ctx;
    }],
    when: ["the coordinator polls both panes", ({ coordinator }) => coordinator.tick()],
    then: ["one usage request qualifies two separate exact-session boundaries", (results, ctx) => {
      try {
        expect(results).toHaveLength(2);
        expect(ctx.readCount()).toBe(1);
        expect(ctx.restarts).toHaveLength(2);
      } finally { ctx.cleanup(); }
    }],
  });

  component("an account change during quota collection cannot authorise a restart", {
    given: ["a successful usage response for the previously selected account", () => {
      let selected = "claude:1";
      const ctx = fixture({ readQuota: async () => {
        selected = "claude:2";
        return { ok: true, profile: { key: "claude:1" }, limits: [{ kind: "weekly_all", usedPercent: 0 }] };
      } });
      ctx.lifecycle.profileFor = () => ({ key: selected });
      return ctx;
    }],
    when: ["quota arrives after the selection changed", ({ coordinator }) => coordinator.tick()],
    then: ["there is no process change or new continuation", (results, ctx) => {
      try {
        expect(results[0].outcome).toMatchObject({ recovered: false, reason: "quota-profile-changed" });
        expect(ctx.restarts).toEqual([]);
        expect(ctx.queue.list("lsrc", 0)).toHaveLength(0);
      } finally { ctx.cleanup(); }
    }],
  });

  component("fresh capacity drives the exact configured Claude pane", {
    given: ["one limited Claude pane", fixture],
    when: ["the coordinator reads a topped-up subscription", ({ coordinator }) => coordinator.tick()],
    then: ["the pane restarts through the same recovery transaction", (results, ctx) => {
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        agentName: "lsrc",
        pane: 0,
        readiness: { ready: true, via: "quota-api" },
        outcome: { recovered: true, restarted: true },
      });
      expect(ctx.restarts).toHaveLength(1);
      ctx.cleanup();
    }],
  });

  component("a restart that throws for one pane still lets the next limited pane recover", {
    given: ["two limited panes whose first tmux session is gone", () => {
      const ctx = fixture();
      writeFileSync(ctx.configPath, ["lsrc:", `  dir: ${join(ctx.cwd, "../..")}`, "  panes:",
        "    - { name: first, cmd: claude }", "    - { name: second, cmd: claude }", ""].join("\n"));
      ctx.lifecycle.restart = async (agentName, pane, ...rest) => {
        ctx.restarts.push([agentName, pane, ...rest]);
        if (pane === 0) throw new Error("can't find session: lsrc");
        return { ok: true, sessionId: receipt.sessionId };
      };
      return ctx;
    }],
    when: ["one poll runs", ({ coordinator }) => coordinator.tick()],
    then: ["the second pane restarts and the first records why it did not", (results, ctx) => {
      try {
        expect(results.map((result) => result.outcome)).toMatchObject([
          { recovered: false, reason: "can't find session: lsrc" },
          { recovered: true, restarted: true },
        ]);
        expect(ctx.queue.list("lsrc", 0).find((job) => job.source === "quota-recovery"))
          .toMatchObject({ lastReason: "Claude exact-session restart failed: can't find session: lsrc" });
      } finally { ctx.cleanup(); }
    }],
  });

  component("a temporary composer guard is retried after fresh quota telemetry", {
    given: ["one limited pane whose composer becomes safe after the first poll", () => {
      const ctx = fixture();
      let attempts = 0;
      ctx.lifecycle.restart = async (...args) => {
        ctx.restarts.push(args);
        attempts++;
        return attempts === 1
          ? { ok: false, reason: "pane-has-no-empty-claude-composer" }
          : { ok: true, sessionId: receipt.sessionId };
      };
      return ctx;
    }],
    when: ["two independent quota polls run", async (ctx) => ({
      blocked: await ctx.coordinator.tick(),
      recovered: await ctx.coordinator.tick(),
    })],
    then: ["the same receipt and continuation recover without a duplicate", ({ blocked, recovered }, ctx) => {
      expect(blocked[0].outcome).toMatchObject({
        recovered: false,
        reason: "pane-has-no-empty-claude-composer",
      });
      expect(recovered[0].outcome).toMatchObject({ recovered: true, restarted: true });
      expect(ctx.restarts).toHaveLength(2);
      expect(ctx.queue.list("lsrc", 0).filter((job) => job.source === "quota-recovery")).toHaveLength(1);
      ctx.cleanup();
    }],
  });

  component("manual same-session recovery reopens scheduling without replaying a submitted job", {
    given: ["pending and submitted jobs parked before a verified manual resume", () => {
      const ctx = fixture();
      ctx.pending = ctx.queue.enqueue({ agentName: "lsrc", pane: 0, text: "not sent yet" });
      const created = ctx.queue.enqueue({ agentName: "lsrc", pane: 0, text: "already submitted, no receipt yet" });
      ctx.submitted = ctx.queue.update(created, { status: "submitted", submitFenceAt: 25_000, submittedAt: 25_000 });
      ctx.coordinator.parkTarget("lsrc", 0, receipt, ctx.cwd);
      ctx.setActiveReceipt(null);
      return ctx;
    }],
    when: ["the poll sees the exact session already recovered", ({ coordinator }) => coordinator.tick()],
    then: ["pending delivery and submitted reconciliation resume, with no restart or cleared fence", (_, ctx) => {
      try {
        expect(ctx.queue.read("lsrc", 0, ctx.pending.id)).toMatchObject({ status: "pending", nextAttemptAt: 30_000 });
        expect(ctx.queue.read("lsrc", 0, ctx.submitted.id)).toMatchObject({
          status: "submitted", submitFenceAt: 25_000, submittedAt: 25_000, nextAttemptAt: 30_000,
        });
        expect(ctx.restarts).toEqual([]);
      } finally { ctx.cleanup(); }
    }],
  });

  component("a different or unverified manual session cannot unpark old delivery", {
    given: ["an old parked job and no current limit, but another session in the pane", () => {
      const ctx = fixture();
      ctx.job = ctx.queue.enqueue({ agentName: "lsrc", pane: 0, text: "keep my fence" });
      ctx.coordinator.parkTarget("lsrc", 0, receipt, ctx.cwd);
      ctx.setActiveReceipt(null);
      ctx.lifecycle.recoveredSession = async () => ({ ok: false, reason: "quota-session-changed" });
      return ctx;
    }],
    when: ["the coordinator polls", ({ coordinator }) => coordinator.tick()],
    then: ["the old queue remains parked without a process change", (_, ctx) => {
      try {
        expect(ctx.queue.read("lsrc", 0, ctx.job.id).nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);
        expect(ctx.restarts).toEqual([]);
      } finally { ctx.cleanup(); }
    }],
  });

  component("a parked continuation resumes when capacity returns without a second restart", {
    given: ["a restarted continuation parked again before it could be delivered", async () => {
      const ctx = fixture();
      ctx.job = ctx.queue.enqueue({ agentName: "lsrc", pane: 0, text: "follow the continuation" });
      ctx.first = await ctx.coordinator.recoverTarget("lsrc", 0, receipt, ctx.cwd);
      ctx.coordinator.parkTarget("lsrc", 0, receipt, ctx.cwd);
      return ctx;
    }],
    when: ["the same receipt becomes recoverable again", ({ coordinator, cwd }) => coordinator.recoverTarget("lsrc", 0, receipt, cwd)],
    then: ["one continuation and its FIFO are schedulable again, with exactly one restart", (result, ctx) => {
      try {
        expect(result).toMatchObject({ recovered: true, restarted: false, replayed: true });
        expect(ctx.restarts).toHaveLength(1);
        expect(ctx.queue.read("lsrc", 0, ctx.first.job.id).nextAttemptAt).toBe(30_000);
        expect(ctx.queue.read("lsrc", 0, ctx.job.id).nextAttemptAt).toBe(30_000);
        expect(ctx.queue.list("lsrc", 0).filter(job => job.source === "quota-recovery")).toHaveLength(1);
      } finally { ctx.cleanup(); }
    }],
  });
});

// 2026-10-18 22:34–04:22Z: skyvw:0 waited on Claude W's spent week, with the lead
// handoff parked behind it, while Claude S had its whole week free.
feature("a spent week resumes on a logged-in account with room", () => {
  const weekly = { ...receipt, limitKind: "weekly" };
  const spentWeek = async () => ({ ok: true, profile: { key: "claude:login:wetterlind" },
    limits: [{ kind: "session", usedPercent: 0 }, { kind: "weekly_all", usedPercent: 100, isActive: true }] });
  const claudeS = { id: "1", key: "claude:1" };
  function spentFixture(coordinatorOptions) {
    const ctx = fixture({ readQuota: spentWeek, coordinatorOptions: {
      findSpareAccount: async ({ current }) => (current?.key === claudeS.key ? null : { profile: claudeS, usedPercent: 0 }),
      ...coordinatorOptions,
    } });
    ctx.setActiveReceipt(weekly);
    ctx.selected = { id: "wetterlind", key: "claude:login:wetterlind" };
    ctx.lifecycle.profileFor = () => ctx.selected;
    ctx.lifecycle.selectProfile = (_agentName, _pane, profile) => { ctx.selected = profile; };
    ctx.handoff = ctx.queue.enqueue({ agentName: "lsrc", pane: 0, text: "[from skyvw:3] the lead is yours again" });
    return ctx;
  }

  component("the exact session restarts on the spare account and its parked handoff is next", {
    given: ["a pane stopped by its weekly limit while another login has room", () => spentFixture()],
    when: ["the coordinator polls", ({ coordinator }) => coordinator.tick()],
    then: ["the pane moved and resumed once; nothing waits for the reset", (results, ctx) => {
      try {
        expect(results[0]).toMatchObject({ switchedTo: "claude:1", outcome: { recovered: true, restarted: true } });
        expect(ctx.selected).toBe(claudeS);
        expect(ctx.restarts).toEqual([["lsrc", 0, weekly, "claude:1"]]);
        const jobs = ctx.queue.list("lsrc", 0);
        expect(jobs[0]).toMatchObject({ source: "quota-recovery", status: "pending", nextAttemptAt: 30_000 });
        expect(ctx.queue.read("lsrc", 0, ctx.handoff.id)).toMatchObject({ status: "pending", nextAttemptAt: 30_000 });
      } finally { ctx.cleanup(); }
    }],
  });

  component("the off switch keeps the old behaviour: parked until the account resets", {
    given: ["the same night with automatic account recovery disabled", () => spentFixture({ switchAccounts: false })],
    when: ["the coordinator polls", ({ coordinator }) => coordinator.tick()],
    then: ["no account change and no restart", (results, ctx) => {
      try {
        expect(results[0].outcome).toMatchObject({ parked: true });
        expect(ctx.selected.key).toBe("claude:login:wetterlind");
        expect(ctx.restarts).toEqual([]);
      } finally { ctx.cleanup(); }
    }],
  });

  // lsrc:0 2026-10-19: a move is a full cache miss, so the pane's pending quota-park compact runs first.
  component("a pending quota-park compact runs before the move", {
    given: ["the same pane while its park compact is still pending", () => spentFixture({ parkPending: () => true })],
    when: ["the coordinator polls", ({ coordinator }) => coordinator.tick()],
    then: ["it stays parked on its account until the compact has run", (results, ctx) => {
      try {
        expect(results[0].outcome).toMatchObject({ parked: true, waiting: "compact-before-move" });
        expect(results[0].switchedTo).toBeUndefined();
        expect(ctx.selected.key).toBe("claude:login:wetterlind");
        expect(ctx.restarts).toEqual([]);
      } finally { ctx.cleanup(); }
    }],
  });

  component("a spent session window does not move accounts", {
    given: ["a session limit while the week still has room", () => {
      const ctx = spentFixture();
      ctx.setActiveReceipt(receipt);
      return ctx;
    }],
    when: ["the coordinator reads a still-spent session", (ctx) => {
      ctx.spareReads = 0;
      return createClaudeQuotaCoordinator({
        queue: ctx.queue, lifecycle: ctx.lifecycle, configPath: ctx.configPath, now: () => 30_000, log: () => {},
        readQuota: async () => ({ ok: true, limits: [{ kind: "session", usedPercent: 100 }, { kind: "weekly_all", usedPercent: 40 }] }),
        findSpareAccount: async () => { ctx.spareReads++; return { profile: claudeS, usedPercent: 0 }; },
      }).tick();
    }],
    then: ["the pane waits for its own session window and no other account is read", (results, ctx) => {
      try {
        expect(results[0].outcome).toMatchObject({ parked: true });
        expect(ctx.spareReads).toBe(0);
        expect(ctx.selected.key).toBe("claude:login:wetterlind");
        expect(ctx.restarts).toEqual([]);
      } finally { ctx.cleanup(); }
    }],
  });
});

// lsrc:0 2026-10-19: the quota park told ten Claude S panes their week stopped them until 04:00Z, and they ended
// their turns. A free reset gave Claude S room at 20:26Z; nothing resumed them, since they had no limit receipt and
// no parked job. claw:1 sat idle until a person woke it about 21:10Z.
const PARK_RESET_AT = Date.parse("2026-10-20T04:00:00Z");
const userLine = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
const endedTurn = (text) => `${JSON.stringify({ type: "assistant", message: { role: "assistant",
  content: [{ type: "text", text }], stop_reason: "end_turn" } })}\n`;
const claudeS = (weekUsed, fetchedAt) => ({ ok: true, provider: "claude", fetchedAt, limits: [
  { id: "session", kind: "session", usedPercent: 2, resetsAt: "2026-10-20T01:10:00Z" },
  { id: "weekly_all", kind: "weekly_all", usedPercent: weekUsed, resetsAt: "2026-10-20T04:00:00Z" },
] });

/** The park store's API, kept in memory: record, read, list, and update that never overwrites a newer park. */
function memoryParkStore() {
  const records = new Map();
  const key = (agentName, pane) => `${agentName}:${pane}`;
  return {
    record: (park) => { records.set(key(park.agentName, park.pane), { ...park, state: "parked" }); return records.get(key(park.agentName, park.pane)); },
    read: (agentName, pane) => records.get(key(agentName, pane)) || null,
    list: () => [...records.values()],
    update(park, fields) {
      const current = records.get(key(park.agentName, park.pane));
      if (current?.parkedAt !== park.parkedAt) return current || null;
      records.set(key(park.agentName, park.pane), { ...current, ...fields });
      return records.get(key(park.agentName, park.pane));
    },
  };
}

/** claw:1 parked at 19:53Z on Claude S; the park notice reached it and it ended its turn. */
function parkedClaw({ readings = [], at = "2026-10-19T20:26:30Z", noticeHeld = false, noticeTurnRunning = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-park-resume-"));
  let clock = Date.parse("2026-10-19T19:53:00Z");
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, ["claw:", `  dir: ${join(root, "claw")}`, "  panes:",
    "    - { name: lead, cmd: claude }", "    - { name: builder, cmd: claude }", ""].join("\n"));
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => clock });
  const session = join(root, "claw-1.jsonl");
  writeFileSync(session, userLine("Build the transcription retry."));
  const store = memoryParkStore();
  const park = store.record({ agentName: "claw", pane: 1, account: { name: "Claude S", key: "claude:1" }, window: "week",
    resetAt: PARK_RESET_AT, parkedAt: new Date(clock).toISOString(),
    identity: { engine: "claude", dir: join(root, "claw", ".agents", "1"), sessionId: "s-claw-1", path: session },
    cursor: captureJsonlAppendCursor("self-compact-request-v1", [session]) });
  // The compact ran at its turn end and the park notice reached the pane, which then ended its turn.
  appendFileSync(session, endedTurn("Retry built; tests next."));
  clock += 60_000;
  const noticeText = quotaParkContinuation({ window: "week", resetAt: PARK_RESET_AT });
  const notice = queue.enqueue({ agentName: "claw", pane: 1, source: "self-compact", text: noticeText });
  // At the quota floor the notice is held in the queue; otherwise it reached the pane, which ended its turn.
  if (!noticeHeld) {
    queue.update(notice, { status: "acknowledged", acknowledgedAt: clock });
    // Claude Code 2.1.296+ records a pasted prompt inside its paste envelope, as lsrc:2's journal did at 19:46Z.
    const recorded = noticeTurnRunning ? `\n\n<pasted_content id="883e">\n${noticeText}\n</pasted_content id="883e">\n` : noticeText;
    appendFileSync(session, `${userLine(recorded)}${noticeTurnRunning ? "" : endedTurn("Parked until the reset; stopping here.")}`);
  }
  clock = Date.parse(at);
  const reads = [];
  const coordinator = createClaudeQuotaCoordinator({
    queue, configPath, now: () => clock, log: () => {}, parkStore: store,
    identityFor: () => ({ sessionId: "s-claw-1", path: session }),
    lifecycle: { activeReceipt: () => null, profileFor: () => ({ key: "claude:1" }) },
    readQuota: async (request) => { reads.push(request); return readings.shift() ?? { ok: false, error: "no reading yet" }; },
  });
  const prompts = () => queue.list("claw", 1).filter((job) => job.source === "quota-recovery");
  return { park, store, queue, session, coordinator, reads, prompts, notice, advance: (ms) => { clock += ms; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("a pane the quota park stopped resumes when its account has room again", () => {
  component("a parked pane with an empty queue gets the same-session recovery prompt once Claude S reads room", {
    given: ["claw:1 parked at 19:53Z, and Claude S reads 0 % used at 20:26:28Z after the free reset",
      () => parkedClaw({ readings: [claudeS(0, "2026-10-19T20:26:28.265Z")] })],
    when: ["quota recovery ticks at 20:26:30Z", (ctx) => ctx.coordinator.tick()],
    then: ["the recovery prompt waits first in claw:1's queue and the park says why it was resumed", (_, ctx) => {
      try {
        expect(ctx.reads).toEqual([expect.objectContaining({ agentName: "claw", pane: 1, notBefore: Date.parse(ctx.park.parkedAt) })]);
        expect(ctx.prompts()).toEqual([expect.objectContaining({ status: "pending", text: quotaRecoveryContinuation() })]);
        expect(ctx.queue.list("claw", 1).filter((job) => job.status === "pending")[0].orderKey).toMatch(/^0{16}:/u);
        expect(ctx.store.read("claw", 1)).toMatchObject({ state: "resumed", reason: "Claude S has 100 % of its week window left" });
      } finally { ctx.cleanup(); }
    }],
  });

  component("a park notice the floor still holds is replaced by the recovery prompt when room returns", {
    given: ["claw:1 parked at the floor, its notice held in the queue, and Claude S reads room",
      () => parkedClaw({ noticeHeld: true, readings: [claudeS(0, "2026-10-19T20:26:28.265Z")] })],
    when: ["quota recovery ticks", (ctx) => ctx.coordinator.tick()],
    then: ["the stale notice is cancelled and the recovery prompt is queued", (_, ctx) => {
      try {
        expect(ctx.queue.read("claw", 1, ctx.notice.id)).toMatchObject({ cancelRequestStatus: "requested", cancelRequestedBy: "quota-recovery" });
        expect(ctx.prompts()).toEqual([expect.objectContaining({ status: "pending", text: quotaRecoveryContinuation() })]);
        expect(ctx.store.read("claw", 1)).toMatchObject({ state: "resumed" });
      } finally { ctx.cleanup(); }
    }],
  });

  // lsrc:0 2026-10-20: a message after the park does not count; only work or a queued message when room returns does.
  component("a parked pane that took a message after its park and went idle gets the recovery prompt", {
    given: ["claw:1 parked, read skydive:0's report at 19:59Z and ended that turn, then Claude S reads room", () => {
      const ctx = parkedClaw({ readings: [claudeS(0, "2026-10-19T20:26:28.265Z")] });
      appendFileSync(ctx.session, userLine("[from skydive:0] Report: the jump log upload is fixed.")
        + endedTurn("Noted; my own task waits for the reset."));
      return ctx;
    }],
    when: ["quota recovery ticks", (ctx) => ctx.coordinator.tick()],
    then: ["the recovery prompt is queued and the park is resumed", (_, ctx) => {
      try {
        expect(ctx.prompts()).toEqual([expect.objectContaining({ status: "pending", text: quotaRecoveryContinuation() })]);
        expect(ctx.store.read("claw", 1)).toMatchObject({ state: "resumed", reason: "Claude S has 100 % of its week window left" });
      } finally { ctx.cleanup(); }
    }],
  });

  component("a pane working on a later request when room returns is left alone", {
    given: ["claw:1 parked, then claw:0 sent it a task it is still working on, and Claude S reads room", () => {
      const ctx = parkedClaw({ readings: [claudeS(0, "2026-10-19T20:26:28.265Z")] });
      appendFileSync(ctx.session, userLine("[from claw:0] Review the Kit view next."));
      return ctx;
    }],
    when: ["quota recovery ticks", (ctx) => ctx.coordinator.tick()],
    then: ["no prompt, and the park says why", (_, ctx) => {
      try {
        expect(ctx.prompts()).toEqual([]);
        expect(ctx.store.read("claw", 1)).toMatchObject({ state: "dropped", reason: "it is working on a later request" });
      } finally { ctx.cleanup(); }
    }],
  });

  component("a message waiting in its queue when room returns leaves it alone, and the held notice never arrives", {
    given: ["claw:1 parked at the floor with its notice and a message from claw:0 both held, and Claude S reads room", () => {
      const ctx = parkedClaw({ noticeHeld: true, readings: [claudeS(0, "2026-10-19T20:26:28.265Z")] });
      ctx.queue.enqueue({ agentName: "claw", pane: 1, source: "cli", text: "[from claw:0] Review the Kit view next." });
      return ctx;
    }],
    when: ["quota recovery ticks", (ctx) => ctx.coordinator.tick()],
    then: ["no prompt, the notice is cancelled and the park says why", (_, ctx) => {
      try {
        expect(ctx.prompts()).toEqual([]);
        expect(ctx.queue.read("claw", 1, ctx.notice.id)).toMatchObject({ cancelRequestStatus: "requested", cancelRequestedBy: "quota-recovery" });
        expect(ctx.store.read("claw", 1)).toMatchObject({ state: "dropped", reason: "a cli message waits in its queue" });
      } finally { ctx.cleanup(); }
    }],
  });

  component("a pane still in its park notice turn when room returns is resumed once that turn ends", {
    given: ["claw:1 is still answering its park notice when Claude S reads room", () => parkedClaw({ noticeTurnRunning: true,
      readings: [claudeS(0, "2026-10-19T20:26:28.265Z"), claudeS(0, "2026-10-19T20:26:58.265Z")] })],
    when: ["quota recovery ticks, the notice turn ends, and it ticks again", async (ctx) => {
      await ctx.coordinator.tick();
      const before = { prompts: ctx.prompts().length, state: ctx.store.read("claw", 1).state };
      appendFileSync(ctx.session, endedTurn("Parked until the reset; stopping here."));
      ctx.advance(30_000);
      await ctx.coordinator.tick();
      return before;
    }],
    then: ["it waits during the notice turn, then gets one prompt", (before, ctx) => {
      try {
        expect(before).toEqual({ prompts: 0, state: "parked" });
        expect(ctx.prompts()).toHaveLength(1);
        expect(ctx.store.read("claw", 1)).toMatchObject({ state: "resumed" });
      } finally { ctx.cleanup(); }
    }],
  });

  component("no room yet, or only a reading from before the park, keeps it parked until its window resets", {
    given: ["Claude S still at 98 %, then a reading taken before the park", () => parkedClaw({ readings: [
      claudeS(98, "2026-10-19T20:26:28.265Z"), claudeS(0, "2026-10-19T19:40:00.000Z")] })],
    when: ["recovery ticks twice, then once after the reset", async (ctx) => {
      await ctx.coordinator.tick();
      const afterFull = ctx.prompts().length;
      await ctx.coordinator.tick();
      const afterStale = ctx.prompts().length;
      ctx.advance(PARK_RESET_AT + 20_000 - Date.parse("2026-10-19T20:26:30Z"));
      await ctx.coordinator.tick();
      return { afterFull, afterStale };
    }],
    then: ["no prompt before the reset, one prompt after it", ({ afterFull, afterStale }, ctx) => {
      try {
        expect([afterFull, afterStale]).toEqual([0, 0]);
        expect(ctx.prompts()).toHaveLength(1);
        expect(ctx.store.read("claw", 1)).toMatchObject({ state: "resumed", reason: "its week window reset at 2026-10-20T04:00:00.000Z" });
      } finally { ctx.cleanup(); }
    }],
  });
});
