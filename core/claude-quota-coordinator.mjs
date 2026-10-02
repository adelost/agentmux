// Durable FIFO coordination around the exact-session restart boundary.

import { appendEvent } from "./events.mjs";
import { listAgents } from "../cli/config.mjs";
import { join } from "node:path";
import {
  isPromptInJsonl,
  isSlashReceiptInJsonl,
} from "./jsonl-reader.mjs";
import { rewriteModelSlash } from "./claude-model.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue.mjs";
import {
  claudeQuotaRecoveryReadiness,
  quotaRecoveryContinuation,
  quotaRecoveryJobKey,
} from "./claude-quota-recovery.mjs";

const PAUSED_UNTIL_RECOVERY = Number.MAX_SAFE_INTEGER;

function sameReceipt(left, right) {
  return Boolean(left && right
    && left.sessionId === right.sessionId
    && left.limitEventId === right.limitEventId);
}

function queueEvent(job, state, detail = null) {
  try {
    appendEvent({
      ts: new Date().toISOString(),
      event: "delivery_queue",
      session: job.agentName,
      pane: job.pane,
      state,
      jobId: job.id,
      source: job.source,
      detail: detail || String(job.verifyText || job.text || "").slice(0, 120),
    });
  } catch { /* diagnostics never mutate delivery truth */ }
}

function exactEcho(job, cwd) {
  if (!job.echoCursor && !job.echoNotBeforeMs) return false;
  const options = job.echoCursor
    ? { cursor: job.echoCursor }
    : { notBeforeMs: Number(job.echoNotBeforeMs) || 0 };
  if (job.kind === "slash") {
    return isSlashReceiptInJsonl(cwd, rewriteModelSlash(job.verifyText), options) === true;
  }
  return isPromptInJsonl(cwd, job.verifyText, options) === true;
}

/**
 * WHAT: Routes quota parking, exact restart, and FIFO reopening.
 * WHY: Keeps ambiguous delivery fences safe across a separate recovery process.
 */
export function createClaudeQuotaCoordinator({
  queue,
  lifecycle,
  configPath,
  readQuota,
  now = () => Date.now(),
  resetGraceMs = 15_000,
  log = (message) => console.log(`quota-recovery | ${message}`),
} = {}) {
  if (!queue || !lifecycle || !configPath || typeof readQuota !== "function") {
    throw new Error("Claude quota coordinator requires queue, lifecycle, config, and quota reader");
  }
  let inFlight = null;

  function acknowledge(job, reason) {
    const current = queue.read(job.agentName, job.pane, job.id) || job;
    const next = queue.update(current, {
      status: "acknowledged",
      acknowledgedAt: now(),
      nextAttemptAt: null,
      lastReason: null,
    });
    queueEvent(next, "acknowledged", reason);
    return next;
  }

  function pause(job, receipt) {
    const current = queue.read(job.agentName, job.pane, job.id) || job;
    const next = queue.update(current, {
      nextAttemptAt: PAUSED_UNTIL_RECOVERY,
      metadata: {
        quotaPreviousStatus: current.metadata?.quotaPreviousStatus || current.status,
        quotaLimitEventId: receipt.limitEventId,
        quotaSessionId: receipt.sessionId,
        quotaLimitedAt: receipt.observedAt,
        quotaResetAt: receipt.resetAt,
      },
      lastReason: "Claude quota is exhausted; exact-session recovery is pending",
    });
    queueEvent(next, "quota_paused", receipt.limitEventId);
    return next;
  }

  function jobsFor(agentName, pane) {
    return queue.list(agentName, pane)
      .filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status));
  }

  function isQuotaParked(job) {
    return job.nextAttemptAt === PAUSED_UNTIL_RECOVERY && Boolean(job.metadata?.quotaLimitEventId);
  }

  function resumeScheduling(job, reason) {
    const current = queue.read(job.agentName, job.pane, job.id);
    if (!current || TERMINAL_DELIVERY_STATES.has(current.status) || current.cancelRequestStatus === "requested" || !isQuotaParked(current)) return current;
    // Status and submit fences belong to delivery reconciliation, not quota scheduling.
    const resumed = queue.update(current, { nextAttemptAt: now(), metadata: { quotaRecoveredAt: now() }, lastReason: reason });
    queueEvent(resumed, "quota_unpaused", current.metadata.quotaLimitEventId);
    return resumed;
  }

  async function reconcileRecoveredTarget(agentName, pane, cwd) {
    const lease = queue.acquireSessionLease(agentName, pane);
    if (!lease) return { recovered: false, reason: "delivery-session-busy" };
    try {
      if (lifecycle.activeReceipt(agentName, pane)) return { recovered: false, reason: "limit-still-active" };
      let count = 0;
      for (const job of jobsFor(agentName, pane).filter(isQuotaParked)) {
        if (job.cancelRequestStatus === "requested") continue;
        const proof = await lifecycle.recoveredSession?.(agentName, pane, job.metadata.quotaSessionId);
        if (!proof?.ok || lifecycle.activeReceipt(agentName, pane)) continue;
        if (exactEcho(job, cwd)) acknowledge(job, "echo-after-manual-quota-recovery");
        else if (job.source === "quota-recovery" && job.status === "pending" && !job.submitFenceAt && !job.submittedAt && !job.draftOwned) {
          queue.requestCancellation(job.id, { reason: "exact session already resumed manually; continuation is superseded", requestedBy: "quota-recovery" });
        } else resumeScheduling(job, "same Claude session already recovered; delivery fences preserved");
        count++;
      }
      return { recovered: count > 0, restarted: false, count };
    } finally { lease.release(); }
  }

  function parkTarget(agentName, pane, receipt, cwd) {
    const lease = queue.acquireSessionLease(agentName, pane);
    if (!lease) return { parked: false, reason: "delivery-session-busy" };
    try {
      if (!sameReceipt(lifecycle.activeReceipt(agentName, pane), receipt)) {
        return { parked: false, reason: "limit-receipt-superseded" };
      }
      let parked = 0;
      for (const job of jobsFor(agentName, pane)) {
        if (exactEcho(job, cwd)) acknowledge(job, "echo-before-quota-recovery");
        else { pause(job, receipt); parked++; }
      }
      return { parked: true, count: parked };
    } finally {
      lease.release();
    }
  }

  async function recoverTarget(agentName, pane, receipt, cwd, expectedProfileKey = null) {
    const lease = queue.acquireSessionLease(agentName, pane);
    if (!lease) return { recovered: false, reason: "delivery-session-busy" };
    try {
      if (!sameReceipt(lifecycle.activeReceipt(agentName, pane), receipt)) {
        return { recovered: false, reason: "limit-receipt-superseded" };
      }
      if (expectedProfileKey && lifecycle.profileFor?.(agentName, pane)?.key !== expectedProfileKey) {
        return { recovered: false, reason: "quota-profile-changed" };
      }
      const idempotencyKey = quotaRecoveryJobKey(agentName, pane, receipt);
      let continuation = queue.enqueue({
        agentName,
        pane,
        text: quotaRecoveryContinuation(),
        source: "quota-recovery",
        idempotencyKey,
        orderKey: `0000000000000000:${idempotencyKey}`,
        metadata: {
          quotaRecoveryLimitId: receipt.limitEventId,
          quotaRecoverySessionId: receipt.sessionId,
        },
      });
      if (continuation.status === "acknowledged" || continuation.metadata?.quotaRestartedAt) {
        for (const job of jobsFor(agentName, pane)) {
          if (job.metadata?.quotaLimitEventId !== receipt.limitEventId) continue;
          if (exactEcho(job, cwd)) acknowledge(job, "echo-after-quota-restart");
          else resumeScheduling(job, "exact session was already restarted; no repeated continuation or restart");
        }
        return { recovered: true, restarted: false, replayed: true, job: continuation };
      }
      pause(continuation, receipt);
      for (const job of jobsFor(agentName, pane)) {
        if (job.id === continuation.id) continue;
        if (exactEcho(job, cwd)) acknowledge(job, "echo-before-quota-restart");
        else pause(job, receipt);
      }

      const restart = expectedProfileKey
        ? await lifecycle.restart(agentName, pane, receipt, expectedProfileKey)
        : await lifecycle.restart(agentName, pane, receipt);
      if (!restart.ok) {
        continuation = queue.update(continuation, {
          nextAttemptAt: PAUSED_UNTIL_RECOVERY,
          metadata: {
            quotaRestartAttempts: Number(continuation.metadata?.quotaRestartAttempts || 0) + 1,
          },
          lastReason: `Claude exact-session restart failed: ${restart.reason}`,
        });
        queueEvent(continuation, "quota_restart_failed", restart.reason);
        return { recovered: false, reason: restart.reason, job: continuation };
      }

      for (const job of jobsFor(agentName, pane)) {
        if (job.id === continuation.id
            || job.metadata?.quotaLimitEventId !== receipt.limitEventId) continue;
        if (exactEcho(job, cwd)) {
          acknowledge(job, "echo-during-quota-restart");
          continue;
        }
        const pending = queue.update(job, {
          status: "pending",
          draftOwned: false,
          submitFenceAt: null,
          submittedAt: null,
          nextAttemptAt: now(),
          metadata: { quotaRecoveredAt: now() },
          lastReason: "old limited process stopped without an echo; exact payload is safe to retry",
        });
        queueEvent(pending, "quota_unpaused", receipt.limitEventId);
      }
      continuation = queue.update(continuation, {
        status: "pending",
        draftOwned: false,
        nextAttemptAt: now(),
        metadata: { quotaRestartedAt: now() },
        lastReason: "exact Claude session resumed; continuation is first in FIFO",
      });
      queueEvent(continuation, "quota_restarted", receipt.sessionId);
      return { recovered: true, restarted: true, replayed: false, job: continuation };
    } finally {
      lease.release();
    }
  }

  async function runTick() {
    let agents;
    try { agents = listAgents(configPath); }
    catch (error) {
      log(`config read failed: ${error.message}`);
      return [];
    }
    const targets = [];
    for (const entry of agents) {
      if (entry.backend === "native") continue;
      for (let pane = 0; pane < entry.panes.length; pane++) {
        if (!/claude/iu.test(String(entry.panes[pane]?.cmd || entry.panes[pane]?.name || ""))) continue;
        const receipt = lifecycle.activeReceipt(entry.name, pane);
        if (receipt || jobsFor(entry.name, pane).some(isQuotaParked)) targets.push({ agentName: entry.name, pane, receipt });
      }
    }
    const results = [];
    const quotas = new Map();
    for (const target of targets) {
      const entry = agents.find((agent) => agent.name === target.agentName);
      const cwd = join(entry.dir, ".agents", String(target.pane));
      if (!target.receipt) {
        const outcome = await reconcileRecoveredTarget(target.agentName, target.pane, cwd);
        results.push({ ...target, outcome });
        continue;
      }
      let quota;
      const profileKey = lifecycle.profileFor?.(target.agentName, target.pane)?.key;
      try {
        if (profileKey && quotas.has(profileKey)) quota = quotas.get(profileKey);
        else {
          quota = await readQuota(target);
          if (profileKey && quota?.profile?.key === profileKey) quotas.set(profileKey, quota);
        }
      }
      catch (error) { quota = { ok: false, engine: "claude", error: error.message }; }
      const readiness = claudeQuotaRecoveryReadiness(target.receipt, quota, {
        now: now(),
        resetGraceMs,
      });
      const outcome = readiness.ready
        ? await recoverTarget(target.agentName, target.pane, target.receipt, cwd, quota?.profile?.key || null)
        : parkTarget(target.agentName, target.pane, target.receipt, cwd);
      if (outcome.restarted) {
        log(`${target.agentName}:${target.pane} resumed ${target.receipt.sessionId} via ${readiness.via}`);
      }
      results.push({ ...target, readiness, outcome });
    }
    return results;
  }

  /** WHAT: Coalesces overlapping quota polls. WHY: Prevents duplicate process restarts from timer overlap. */
  function tick() {
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { tick, parkTarget, recoverTarget };
}
