// Stale delivery guard: a job parked in a physical stage beyond its bound
// must become LOUD, never auto-terminal. Ambiguity is preserved by contract.

import { DELIVERED_UNVERIFIED_STATE } from "./delivery-queue-policy.mjs";

const STALE_WARN_MS = 20 * 60_000;
const PHYSICAL_STATES = new Set(["pasting", "submitting"]);

/** WHAT: Checks whether one job is parked past its physical bound. WHY: Prevents a dead pane from jamming later messages invisibly. */
export function staleDeliveryJobDecision(job, nowMs) {
  if (!job || !PHYSICAL_STATES.has(job.status)) return { stale: false };
  const base = Number(job.lastAttemptAt || job.createdAt);
  if (!Number.isFinite(base) || base <= 0) return { stale: false };
  const ageMs = nowMs - base;
  if (ageMs < STALE_WARN_MS) return { stale: false };
  return {
    stale: true,
    reason: `stale-${job.status}: no receipt in ${Math.round(ageMs / 60_000)}min (bound ${Math.round(STALE_WARN_MS / 60_000)}min)`,
  };
}

/** WHAT: Reports jobs parked past their bound with an event and log, never a rewrite. WHY: Keeps stale jams visible while ambiguous jobs stay recoverable. */
export async function reportStaleDeliveryJobs({ agentName, pane, queue, now, queueEvent, log }) {
  const reported = [];
  for (const job of queue.list(agentName, pane)) {
    const decision = staleDeliveryJobDecision(job, now());
    if (!decision.stale) continue;
    if (job.staleNoticeSentAt) continue;
    queue.update(job, { staleNoticeSentAt: now(), staleNoticeReason: decision.reason });
    queueEvent(job, "stale-warning", { reason: decision.reason });
    log(`stale delivery ${agentName}:${pane} ${job.id}: ${decision.reason}`);
    reported.push(job.id);
  }
  return reported;
}

/** WHAT: Rechecks the authoritative sink for lane-released slash verdicts. WHY: A receipt delayed past the lane deadline (e.g. behind a /compact) must flip the verdict instead of leaving a false warning armed. */
async function reconcileLateEchoWatch({ agentName, pane, queue, now, exactEcho, acknowledge }) {
  if (typeof exactEcho !== "function" || typeof acknowledge !== "function") return;
  for (const job of queue.list(agentName, pane)) {
    if (job.status !== DELIVERED_UNVERIFIED_STATE || !job.lateEchoWatchUntil) continue;
    if (Number(job.lateEchoWatchUntil) <= now()) {
      // The watch lapsed with no receipt: close it honestly so the deferred
      // warning (already scheduled via unverifiedNoticeNextAttemptAt) reports
      // a reason that matches what actually happened.
      queue.update(job, {
        lateEchoWatchUntil: null,
        lastReason: "no exact command receipt within the 60-minute watch window; delivery remains unverified",
      });
      continue;
    }
    if (await exactEcho(job)) await acknowledge(job, "late-echo-after-unverified");
  }
}

/** WHAT: Dispatches cancellation requests, terminal notices, and stale reporting before delivery. WHY: Keeps every pre-delivery terminal path in one ordered pass. */
export async function runDeliveryPreflight({ agentName, pane, queue, now, queueEvent, log, terminalizeNotSent, notifyTerminal, exactEcho = null, acknowledge = null }) {
  const cancellationRequests = queue.pendingCancellationRequests?.(agentName, pane) || [];
  for (const request of cancellationRequests) await terminalizeNotSent(request);
  await reconcileLateEchoWatch({ agentName, pane, queue, now, exactEcho, acknowledge });
  const notices = (queue.pendingTerminalNotices?.(agentName, pane)
    || queue.pendingUnverifiedNotices?.(agentName, pane) || [])
    .filter((job) => Number(job.unverifiedNoticeNextAttemptAt || 0) <= now());
  for (const notice of notices) await notifyTerminal(notice);
  return reportStaleDeliveryJobs({ agentName, pane, queue, now, queueEvent, log });
}
