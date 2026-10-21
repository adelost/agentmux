import { PAUSED_UNTIL_RECOVERY, TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { QUOTA_WIND_DOWN_ORIGIN } from "./quota-wind-down.mjs";

/** WHAT: Checks for an unpublished move intent. WHY: Prevents recovery from changing a continuation already handed to delivery. */
export const isPausedWindDownContinuation = job => job.source === QUOTA_WIND_DOWN_ORIGIN
  && job.status === "pending" && job.nextAttemptAt === PAUSED_UNTIL_RECOVERY
  && !job.cancelRequestStatus && Boolean(job.metadata?.windDownSessionId && job.metadata?.windDownTargetProfileKey);

/** WHAT: Stores the saved continuation's exact restart receipt. WHY: Keeps retries on one durable FIFO identity. */
export function releaseWindDownContinuation(queue, job, now) {
  const current = queue.read(job.agentName, job.pane, job.id);
  if (!current || TERMINAL_DELIVERY_STATES.has(current.status) || current.cancelRequestStatus) return current;
  return queue.update(current, { status: "pending", nextAttemptAt: now,
    metadata: { windDownRestartedAt: now }, lastReason: "exact wind-down session restarted; continuation is first in FIFO" });
}

/** WHAT: Stores cancellation of an unsubmitted failed move under its session lease. WHY: Prevents a paused FIFO head from blocking ordinary followers. */
export function cancelWindDownContinuation(queue, job, reason) {
  return queue.requestCancellation(job.id, { requestedBy: QUOTA_WIND_DOWN_ORIGIN, reason });
}

/** WHAT: Checks move intents on the existing quota recovery poll. WHY: Keeps recovery independent of the old quota stage, which disappears after a move. */
export async function reconcileWindDownContinuations({ queue, lifecycle, agentName, pane, now }) {
  if (!queue.list(agentName, pane).some(isPausedWindDownContinuation)) return [];
  const lease = queue.acquireSessionLease(agentName, pane);
  if (!lease) return [];
  try {
    const outcomes = [];
    for (const job of queue.list(agentName, pane).filter(isPausedWindDownContinuation)) {
      const { windDownSessionId: sessionId, windDownTargetProfileKey: target,
        windDownSourceProfileKey: source, windDownResetAt: resetAt } = job.metadata;
      const recovered = await lifecycle.recoveredSession(agentName, pane, sessionId, target);
      if (recovered?.ok) {
        releaseWindDownContinuation(queue, job, now());
        outcomes.push({ agentName, pane, windDown: "released", jobId: job.id });
      } else if (Number(resetAt) <= now() && source
          && await lifecycle.liveProfileIs?.(agentName, pane, source)) {
        cancelWindDownContinuation(queue, job, "wind-down episode ended while the pane still ran on the source");
        outcomes.push({ agentName, pane, windDown: "cancel-requested", jobId: job.id });
      }
    }
    return outcomes;
  } finally { lease.release(); }
}
