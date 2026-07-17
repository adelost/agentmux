import { feature, component, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createClaudeQuotaCoordinator } from "./claude-quota-coordinator.mjs";
import { isClaudeQuotaContinuationAuthorized } from "./claude-quota-target.mjs";
import { quotaRecoveryContinuation } from "./claude-quota-recovery.mjs";

const receipt = {
  sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  limitEventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  limitKind: "session",
  observedAt: 1_000,
  resetAt: 20_000,
};

function fixture() {
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
    restart: async (...args) => {
      restarts.push(args);
      return { ok: true, sessionId: receipt.sessionId };
    },
  };
  const coordinator = createClaudeQuotaCoordinator({
    queue,
    lifecycle,
    configPath,
    readQuota: async () => ({ ok: true, limits: [{ kind: "session", usedPercent: 7 }] }),
    now: () => clock,
    log: () => {},
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
});
