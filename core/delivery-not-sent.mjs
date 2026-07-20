// Pre-submit NOT SENT adjudication for the delivery broker.
//
// A job that never reached Enter gets a bounded safety budget (attempts and
// age). When the budget ends without an authoritative receipt the message is
// never dropped silently: a pre-submit timeout PARKS the head with a fresh
// budget (FIFO and message preserved, one notice per park cycle), while
// sender cancels and proven-not-ingesting followers stay terminal.
// The single writer lease means only the broker ever runs these transitions.

import {
  DELIVERED_UNVERIFIED_STATE, TERMINAL_DELIVERY_STATES,
  NOT_INGESTING_UNVERIFIED_STREAK, isNotSentDeliveryJob,
  isTargetProvenNotIngesting,
} from "./delivery-queue.mjs";

const STALE_PRE_SUBMIT_TERMINAL_MS = 60 * 60 * 1_000;
const MAX_PRE_SUBMIT_ATTEMPTS = 64;
/** WHAT: Names the job states that precede any physical submit. WHY: Separates pre-Enter parking from post-fence unverified outcomes. */
export const PRE_SUBMIT_STATES = new Set(["pending", "delivering", "pasting", "drafted"]);
// A head that exhausts its pre-submit budget is never dropped: it parks this
// long, then gets a fresh budget. The FIFO and the message are preserved.
const PRE_SUBMIT_PARK_MS = 5 * 60_000;

/** WHAT: Builds the pre-submit NOT SENT transitions over the broker's seams. WHY: Keeps parking and cancellation policy out of the delivery loop. */
export function createDeliveryNotSent({
  queue, agent, now, notify, log, queueEvent, exactEcho, acknowledge, notifyTerminal,
}) {
  const cancellationRequested = (job) => job.cancelRequestStatus === "requested";

  /** WHAT: Checks whether a pre-submit job spent its retry budget. WHY: Prevents one wedged composer from consuming the FIFO forever. */
  function stalePreSubmit(job) {
    if (!PRE_SUBMIT_STATES.has(job.status) || Number(job.attempts || 0) <= 0) return false;
    const firstAttemptAt = Number(job.firstAttemptAt || job.createdAt || 0);
    const age = firstAttemptAt ? Math.max(0, now() - firstAttemptAt) : 0;
    return age >= STALE_PRE_SUBMIT_TERMINAL_MS
      || Number(job.attempts || 0) >= MAX_PRE_SUBMIT_ATTEMPTS;
  }

  /** WHAT: Checks whether the target proved it does not ingest. WHY: Keeps the breaker evidence-based, never age-based. */
  function targetProvenNotIngesting(job) {
    return isTargetProvenNotIngesting(queue.list(job.agentName, job.pane));
  }

  /** WHAT: Classifies why one job qualifies as NOT SENT. WHY: Separates parked timeouts from terminal cancels. */
  function notSentCause(job) {
    if (!PRE_SUBMIT_STATES.has(job.status)) return null;
    let nativeAttemptMayHaveLeft = false;
    if (Number(job.attempts || 0) > 0 && typeof agent.isNativeTarget === "function") {
      try {
        nativeAttemptMayHaveLeft = Boolean(agent.isNativeTarget(job.agentName, job.pane));
      } catch {
        // Unknown routing is ambiguity, never proof that nothing was sent.
        nativeAttemptMayHaveLeft = true;
      }
    }
    if (nativeAttemptMayHaveLeft) return null;
    if (cancellationRequested(job)) return "sender-cancel";
    if (stalePreSubmit(job)) return "pre-submit-timeout";
    if (targetProvenNotIngesting(job)) return "target-not-ingesting";
    return null;
  }

  /** WHAT: Stores one settled cancellation request. WHY: Keeps cancellation a request, never a producer-side rewrite. */
  function settleCancellation(initialJob, status, reason) {
    const current = queue.read(initialJob.agentName, initialJob.pane, initialJob.id) || initialJob;
    if (!cancellationRequested(current)) return current;
    const settled = queue.update(current, {
      cancelRequestStatus: status,
      cancelRequestResolvedAt: now(),
      cancelRequestLastReason: reason,
    });
    queueEvent(settled, `cancel_${status}`, { reason: String(reason).slice(0, 160) });
    return settled;
  }

  /** WHAT: Adjudicates a cancellation outside the pre-submit states. WHY: Prevents a late cancel from rewriting delivery truth. */
  function settleCancellationOutsidePreSubmit(job) {
    if (!cancellationRequested(job)) return job;
    if (isNotSentDeliveryJob(job)) {
      return settleCancellation(job, "completed", "job is terminal and was not sent");
    }
    if (job.status === "acknowledged") {
      return settleCancellation(job, "refused", "authoritative receipt already exists; cancellation cannot be called NOT SENT");
    }
    if (job.status === "submitting"
        || job.status === "submitted"
        || job.status === DELIVERED_UNVERIFIED_STATE) {
      return settleCancellation(job, "refused", "submit may already have been attempted; cancellation cannot be called NOT SENT");
    }
    if (TERMINAL_DELIVERY_STATES.has(job.status)) {
      return settleCancellation(job, "refused", `job already ended as ${job.status}; cancellation was not applied`);
    }
    return settleCancellation(job, "refused", `state ${job.status} is not safe for pre-submit cancellation`);
  }

  /** WHAT: Parks one exhausted head instead of dropping its message. WHY: Keeps the FIFO intact while the stall stays visible. */
  async function parkPreSubmitTimeout(current) {
    const parked = queue.update(current, {
      status: current.draftOwned ? "pasting" : "pending",
      attempts: 0,
      firstAttemptAt: null,
      nextAttemptAt: now() + PRE_SUBMIT_PARK_MS,
      noticeSentAt: now(),
      lastReason: "composer stayed unsafe for a full receipt budget; message kept in queue, "
        + `retry continues in ${Math.floor(PRE_SUBMIT_PARK_MS / 60_000)} min (park, not drop)`,
    });
    queueEvent(parked, "parked_pre_submit", { reason: "pre-submit-timeout" });
    await notify(parked, "blocked").catch((error) =>
      log(`delivery broker park notice failed for ${parked.id}: ${error.message}`));
    return parked;
  }

  /** WHAT: Ends or parks one pre-submit job with the receipt re-read at the boundary. WHY: Prevents a stale observer from overwriting a late acknowledgement. */
  async function terminalizeNotSent(job) {
    let current = queue.read(job.agentName, job.pane, job.id) || job;
    let cause = notSentCause(current);
    if (!cause) return settleCancellationOutsidePreSubmit(current);

    // A late authoritative receipt always wins. Re-read the durable state at
    // the transition boundary so an acknowledgement or submit fence cannot
    // be overwritten by a stale pre-submit observer.
    if (await exactEcho(current)) {
      return settleCancellationOutsidePreSubmit(
        await acknowledge(current, "late-echo-before-not-sent"),
      );
    }
    current = queue.read(current.agentName, current.pane, current.id) || current;
    cause = notSentCause(current);
    if (!cause) return settleCancellationOutsidePreSubmit(current);
    if (await exactEcho(current)) {
      return settleCancellationOutsidePreSubmit(
        await acknowledge(current, "late-echo-before-not-sent"),
      );
    }
    current = queue.read(current.agentName, current.pane, current.id) || current;
    cause = notSentCause(current);
    if (!cause) return settleCancellationOutsidePreSubmit(current);

    if (cause === "pre-submit-timeout") return parkPreSubmitTimeout(current);

    const firstAttemptAt = Number(current.firstAttemptAt || current.createdAt || now());
    const ageMinutes = Math.max(0, Math.floor((now() - firstAttemptAt) / 60_000));
    const requestedReason = String(current.cancelRequestedReason || "sender no longer needs this job");
    const requestedBy = String(current.cancelRequestedBy || "unknown sender");
    const terminalReason = cause === "sender-cancel"
      ? `not sent: cancellation requested by ${requestedBy} before submit (${requestedReason}); composer preserved`
      : cause === "target-not-ingesting"
        ? `not sent: ${current.agentName}:${current.pane} let ${NOT_INGESTING_UNVERIFIED_STREAK} consecutive receipt budgets expire without ingesting a prompt; resend once that pane acknowledges again`
        : `not sent: composer remained unsafe for ${ageMinutes} minute(s) across ${Number(current.attempts || 0)} attempt(s); automatic retries stopped`;
    const terminal = queue.update(current, {
      status: "cancelled",
      draftOwned: false,
      terminalAt: now(),
      nextAttemptAt: null,
      unverifiedNoticeSentAt: null,
      unverifiedNoticeNextAttemptAt: now(),
      metadata: {
        deliveryOutcome: "not-sent",
        ...(cause === "pre-submit-timeout" ? { deliveryTimeout: "pre-submit" } : {}),
        ...(cause === "sender-cancel" ? { deliveryCancellation: "sender-request" } : {}),
        ...(cause === "target-not-ingesting" ? { deliveryTarget: "not-ingesting" } : {}),
      },
      ...(cause === "sender-cancel" ? {
        cancelRequestStatus: "completed",
        cancelRequestResolvedAt: now(),
        cancelRequestLastReason: "cancelled before submit; job was not sent",
      } : {}),
      lastReason: terminalReason,
    });
    queueEvent(terminal, "cancelled", { reason: cause });
    return notifyTerminal(terminal);
  }

  return {
    stalePreSubmit,
    terminalizeNotSent,
  };
}
