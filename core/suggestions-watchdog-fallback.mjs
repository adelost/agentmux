// Durable broker-unavailable fallback state for Suggestions watchdog jobs.
// Delivery truth remains in delivery-queue status fields; this module only
// records a bounded operator fallback and never manufactures an ACK.

import { isNotSentDeliveryJob } from "./delivery-queue.mjs";

/** WHAT: Defines the broker-unavailable fallback deadline. WHY: Keeps pending delivery from remaining opaque forever. */
export const DEFAULT_BROKER_FALLBACK_AFTER_MS = 5 * 60_000;

const FALLBACK_STATES = new Set(["blocked", "cancelled", "escalating", "escalated"]);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const boundedReason = (value) => String(value || "unknown").replace(/\s+/gu, " ").slice(0, 500);

function assertOptions(queue, job, observedAt, fallbackAfterMs) {
  if (!queue || typeof queue.read !== "function" || typeof queue.update !== "function") {
    throw new Error("fallback: durable delivery queue is required");
  }
  if (!job?.id || !job?.agentName || !Number.isSafeInteger(Number(job.pane))) {
    throw new Error("fallback: durable delivery job is required");
  }
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new Error("fallback: clock must return a non-negative integer");
  }
  if (!Number.isSafeInteger(fallbackAfterMs)
    || fallbackAfterMs < 1_000 || fallbackAfterMs > 30 * 60_000) {
    throw new Error("fallback: brokerFallbackAfterMs must be 1000-1800000");
  }
}

function sourceGeneration(job) {
  const persisted = Number(job.metadata?.watchdogDeliveryGeneration);
  if (Number.isSafeInteger(persisted) && persisted > 0) return persisted;
  return 1;
}

function fallbackDeadline(job, observedAt, fallbackAfterMs) {
  const persisted = Number(job.metadata?.watchdogFallbackDeadlineAt);
  if (Number.isSafeInteger(persisted) && persisted >= 0) return persisted;
  const createdAt = Number(job.createdAt);
  return (Number.isSafeInteger(createdAt) && createdAt >= 0 ? createdAt : observedAt)
    + fallbackAfterMs;
}

function fallbackIdentity(job, generation) {
  const persisted = job.metadata?.watchdogEscalationIdempotencyKey;
  return typeof persisted === "string" && persisted
    ? persisted
    : `suggestions-watchdog-fallback:${job.id}:g${generation}`;
}

function fallbackMessage({ job, projectId, alert, generation, reason }) {
  return `[SRC-0108] Watchdog delivery ${projectId}/${alert?.id ?? "unknown"}`
    + ` (${alert?.ticketId || "unknown ticket"}) to ${job.agentName}:${job.pane}`
    + ` remained unacknowledged through broker-delivery generation ${generation}.`
    + ` ownerAckClockStarted=false; no broker ACK was recorded.`
    + ` Durable fallback reason: ${reason}.`;
}

function currentJob(queue, job) {
  return queue.read(job.agentName, job.pane, job.id) || job;
}

function updateMetadata(queue, job, metadata) {
  return queue.update(currentJob(queue, job), { metadata });
}

/** WHAT: Builds one watchdog fallback state. WHY: Keeps countdown and ACK truth identical in logs and status UI. */
export function watchdogFallbackView(job, { now = Date.now() } = {}) {
  const state = job?.metadata?.watchdogFallbackState;
  if (job?.source !== "suggestions-watchdog" || !FALLBACK_STATES.has(state)) return null;
  const observedAt = Number(now);
  const deadlineAt = Number(job.metadata.watchdogFallbackDeadlineAt);
  const remainingMs = state === "blocked" && Number.isSafeInteger(deadlineAt)
    ? Math.max(0, deadlineAt - observedAt) : 0;
  return {
    jobId: job.id,
    target: `${job.agentName}:${job.pane}`,
    projectId: job.metadata.projectId || "unknown",
    outboxId: job.metadata.outboxId ?? null,
    deliveryGeneration: Number(job.metadata.watchdogDeliveryGeneration || 1),
    state,
    deadlineAt: Number.isSafeInteger(deadlineAt) ? deadlineAt : null,
    remainingMs,
    ownerAckClockStarted: false,
    humanEscalation: state === "escalated"
      ? (job.metadata.watchdogEscalationDeduped ? "deduped" : "sent") : "none",
    reason: job.metadata.watchdogFallbackCancelReason
      || job.metadata.watchdogEscalationReason || null,
  };
}

/** WHAT: Formats one watchdog fallback row. WHY: Gives operators a countdown without reading queue JSON. */
export function formatWatchdogFallbackView(view) {
  if (!view) return "";
  const remaining = `${Math.ceil(view.remainingMs / 1_000)}s`;
  return `FALLBACK job=${view.jobId} project=${view.projectId}/${view.outboxId ?? "?"}`
    + ` target=${view.target} generation=${view.deliveryGeneration} state=${view.state}`
    + ` remaining=${remaining} ownerAckClockStarted=false human=${view.humanEscalation}`
    + `${view.reason ? ` reason=${boundedReason(view.reason)}` : ""}`;
}

/** WHAT: Resolves one durable broker fallback. WHY: Prevents restarts or ambiguous notify receipts from duplicating human effects. */
export async function reconcileWatchdogFallback({
  queue,
  job,
  projectId,
  alert,
  now = () => Date.now(),
  fallbackAfterMs = DEFAULT_BROKER_FALLBACK_AFTER_MS,
  escalate = null,
  forceReason = null,
}) {
  const observedAt = Number(now());
  assertOptions(queue, job, observedAt, fallbackAfterMs);
  let current = currentJob(queue, job);
  const generation = sourceGeneration(current);
  const deadlineAt = fallbackDeadline(current, observedAt, fallbackAfterMs);
  const initialState = FALLBACK_STATES.has(current.metadata?.watchdogFallbackState)
    ? current.metadata.watchdogFallbackState : "blocked";
  if (!FALLBACK_STATES.has(current.metadata?.watchdogFallbackState)
    || current.metadata?.watchdogOwnerAckClockStarted !== false) {
    current = updateMetadata(queue, current, {
      watchdogDeliveryGeneration: generation,
      watchdogFallbackState: initialState,
      watchdogFallbackDeadlineAt: deadlineAt,
      watchdogOwnerAckClockStarted: false,
    });
  }

  const state = current.metadata.watchdogFallbackState;
  if (current.status === "acknowledged") {
    if (state !== "escalated" && state !== "cancelled") {
      const beforeDeadline = observedAt < deadlineAt;
      current = updateMetadata(queue, current, {
        watchdogFallbackState: "cancelled",
        watchdogFallbackCancelledAt: observedAt,
        watchdogFallbackCancelReason: beforeDeadline
          ? "broker-recovered-before-deadline" : "broker-recovered-before-escalation",
      });
    }
    return { job: current, ...watchdogFallbackView(current, { now: observedAt }) };
  }

  if (!forceReason && observedAt < deadlineAt) {
    return { job: current, ...watchdogFallbackView(current, { now: observedAt }) };
  }
  if (state === "escalated") {
    return { job: current, ...watchdogFallbackView(current, { now: observedAt }) };
  }

  const reason = forceReason || "delivery-remained-unacknowledged-before-deadline";
  const idempotencyKey = fallbackIdentity(current, generation);
  current = updateMetadata(queue, current, {
    watchdogFallbackState: "escalating",
    watchdogFallbackStartedAt: current.metadata.watchdogFallbackStartedAt ?? observedAt,
    watchdogEscalationAttemptedAt: observedAt,
    watchdogEscalationAttempts: Number(current.metadata.watchdogEscalationAttempts || 0) + 1,
    watchdogEscalationIdempotencyKey: idempotencyKey,
    watchdogEscalationReason: reason,
    watchdogEscalationLastError: null,
  });
  if (typeof escalate !== "function") {
    throw new Error("fallback: human escalation transport is required at the deadline");
  }
  let receipt;
  try {
    receipt = await escalate({
      idempotencyKey,
      message: fallbackMessage({ job: current, projectId, alert, generation, reason }),
      projectId,
      alert,
      job: current,
      ownerAckClockStarted: false,
    });
    if (!isObject(receipt) || (receipt.sent !== true && receipt.deduped !== true)) {
      throw new Error("human escalation returned no sent/deduped receipt");
    }
  } catch (error) {
    updateMetadata(queue, current, {
      watchdogFallbackState: "escalating",
      watchdogEscalationLastError: boundedReason(error.message),
    });
    throw error;
  }
  current = updateMetadata(queue, current, {
    watchdogFallbackState: "escalated",
    watchdogEscalatedAt: observedAt,
    watchdogEscalationSent: receipt.sent === true,
    watchdogEscalationDeduped: receipt.deduped === true,
    watchdogEscalationTarget: boundedReason(receipt.target || "unknown"),
    watchdogEscalationLastError: null,
  });
  return { job: current, ...watchdogFallbackView(current, { now: observedAt }) };
}

/** WHAT: Resolves terminal not-sent recovery before fallback observation. WHY: Keeps one retry and later human escalation on one generation fence. */
export async function prepareWatchdogDelivery({
  queue,
  job,
  projectId,
  alert,
  now,
  cancelledRetryAfterMs,
  fallbackAfterMs,
  escalate,
}) {
  if (job.status !== "cancelled" || !isNotSentDeliveryJob(job)) return job;
  const observedAt = Number(now());
  const terminalAt = Number(job.terminalAt);
  assertOptions(queue, job, observedAt, fallbackAfterMs);
  if (!Number.isSafeInteger(terminalAt) || terminalAt < 0) {
    throw new Error(`delivery: cancelled agentmux job ${job.id} lacks a durable not-sent boundary; human escalation required`);
  }
  const reenqueueCount = Number(job.metadata?.watchdogReenqueueCount || 0);
  if (reenqueueCount >= 1) {
    await reconcileWatchdogFallback({ queue, job, projectId, alert, now, fallbackAfterMs,
      escalate, forceReason: "not-sent-after-bounded-reenqueue" });
    throw new Error(`delivery: agentmux job ${job.id} remained not-sent after one bounded re-enqueue; human escalation persisted`);
  }
  const eligibleAt = terminalAt + cancelledRetryAfterMs;
  if (observedAt < eligibleAt) {
    throw new Error(`delivery: agentmux job ${job.id} is proven not-sent; bounded re-enqueue opens in ${eligibleAt - observedAt}ms`);
  }
  return queue.update(job, {
    status: "pending",
    acknowledgedAt: null,
    terminalAt: null,
    nextAttemptAt: observedAt,
    lastReason: "watchdog outbox re-enqueued one prompt after a durable not-sent cancellation",
    metadata: {
      watchdogReenqueueCount: 1,
      watchdogReenqueuedAt: observedAt,
      watchdogOriginalTerminalAt: terminalAt,
      watchdogDeliveryGeneration: Number(job.metadata?.watchdogDeliveryGeneration || 1) + 1,
      watchdogFallbackState: "blocked",
      watchdogFallbackDeadlineAt: observedAt + fallbackAfterMs,
      watchdogFallbackStartedAt: null,
      watchdogFallbackCancelledAt: null,
      watchdogFallbackCancelReason: null,
      watchdogEscalatedAt: null,
      watchdogEscalationIdempotencyKey: null,
      watchdogEscalationReason: null,
      watchdogEscalationLastError: null,
      watchdogOwnerAckClockStarted: false,
    },
  });
}
