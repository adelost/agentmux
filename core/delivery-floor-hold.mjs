// A pane whose open work is only prompts the quota floor holds is served without the session writer lease.
// 12 Nov 14:24-14:58Z (deep:0): skyvw:1's floor-held job took the skyvw session lease on every 500 ms poll and 13 wake
// attempts in 9 min, so rotation refused the idle skyvw:0 as delivery-lease-busy until 14:53Z; claw:2's held job had 17.
import { TERMINAL_DELIVERY_STATES, blockedRetryMs } from "./delivery-queue-policy.mjs";
import { deliveryHead, isQuotaFloorHeldJob, quotaFloorRefusal } from "./delivery-wake.mjs";
import { reportBlockedHandoffs } from "./delivery-handoff.mjs";
import { withDeliveryPreparation } from "./delivery-preparation.mjs";

const unsentPrompt = job => job.kind === "prompt" && job.status === "pending" && !job.draftOwned
  && !job.submittedAt && !job.submitFenceAt && !job.cancelRequestStatus;

/**
 * WHAT: Builds the check that holds a floor-held pane without its writer lease.
 * WHY: Keeps a refused wake from locking the session rotation needs to move the pane off.
 */
export function createFloorHold({ queue, quotaFloor, now, preparationTimeoutMs, queueEvent, maybeNotifyBlocked, exactEcho, acknowledge, log, agent }) {
  return async function floorHold(agentName, pane) {
    if (!quotaFloor) return false;
    const jobs = queue.list(agentName, pane);
    const open = jobs.filter(job => !TERMINAL_DELIVERY_STATES.has(job.status));
    // Anything else on the pane (a draft, a submit fence, a cancel, a terminal notice) is served under the lease.
    if (!open.length || !open.every(unsentPrompt) || (queue.pendingTerminalNotices?.(agentName, pane) || []).length) return false;
    const head = deliveryHead(jobs);
    if (Number(head.nextAttemptAt || 0) > now()) return isQuotaFloorHeldJob(head);
    // The same bounded preparation the leased path uses: a stalled quota read keeps the hold, as delivery-writer.mjs does.
    const reason = await withDeliveryPreparation({ timeoutMs: preparationTimeoutMs,
      onStage: (stage, ms) => log(`delivery floor hold ${agentName}:${pane} ${head.id}: ${stage} ${ms}ms`),
      onTimeout: error => `quota-floor: ${error.message}; fresh account reading unavailable; existing hold remains` },
    () => quotaFloorRefusal({ job: head, quotaFloor, now }));
    if (!reason) return false;
    const attempts = Number(head.attempts || 0) + 1;
    const retryMs = reason.includes("preparation-timeout") ? 60_000 : blockedRetryMs({ attempts });
    const held = queue.update(head, { status: "pending", attempts, firstAttemptAt: head.firstAttemptAt || now(),
      nextAttemptAt: now() + retryMs, lastReason: `wake-refused:${reason}`, costHold: true });
    if (head.lastReason !== held.lastReason) queueEvent(held, "wake_refused", { reason, lease: false });
    await maybeNotifyBlocked(held);
    await reportBlockedHandoffs({ agentName, pane, queue, now, exactEcho, acknowledge, log, agent });
    return true;
  };
}
