// Post-submit terminal outcomes for the single-writer delivery broker.

import { CLOSED_CODEX_RECOVERY_KIND } from "./codex-submit-boundary.mjs";
import {
  DELIVERED_UNVERIFIED_STATE,
  TERMINAL_DELIVERY_STATES,
} from "./delivery-queue-policy.mjs";

const LATE_ECHO_WATCH_MS = 60 * 60 * 1_000;

/**
 * WHAT: Builds post-submit terminalization and legacy contradiction repair.
 * WHY: Keeps ambiguous delivery outcomes out of the physical write loop.
 */
export function createDeliveryTerminalizer({
  queue, agent, now, notify, notifyTerminal, log, queueEvent, exactEcho, acknowledge,
}) {
  /** WHAT: Repairs legacy NOT SENT terminals that retained proof of an earlier Codex submit. WHY: A cancellation after a recovered submit cannot truthfully erase the submit ambiguity. */
  async function reconcileRecoveredCancellationTerminals() {
    if (typeof queue.allTargets !== "function") return;
    for (const { agentName, pane } of queue.allTargets()) {
      for (const job of queue.list(agentName, pane)) {
        const contradictory = job.status === "cancelled"
          && job.metadata?.deliveryOutcome === "not-sent"
          && job.metadata?.submittedRecoveryKind === CLOSED_CODEX_RECOVERY_KIND;
        if (!contradictory) continue;
        const corrected = queue.update(job, {
          status: DELIVERED_UNVERIFIED_STATE,
          terminalAt: now(),
          nextAttemptAt: null,
          cancelRequestStatus: "refused",
          cancelRequestResolvedAt: now(),
          cancelRequestLastReason: "a submit was attempted before cancellation; cancellation cannot be called NOT SENT",
          unverifiedNoticeSentAt: null,
          unverifiedNoticeNextAttemptAt: now(),
          metadata: {
            deliveryOutcome: "consumed-unverified",
            deliveryCancellation: null,
            deliveryAmbiguity: "recovered-submit-cancelled-as-not-sent",
          },
          lastReason: "a prior Codex submit recovery proves delivery was attempted; corrected the contradictory NOT SENT receipt to consumed/unverified and suppressed redispatch",
        });
        queueEvent(corrected, DELIVERED_UNVERIFIED_STATE, { via: "recovered-terminal-reconciliation" });
        await notifyTerminal(corrected);
      }
    }
  }

  /** WHAT: Ends one ambiguous post-submit delivery without redispatch. WHY: Missing receipts must release the lane without inventing NOT SENT. */
  async function terminalizeUnverified(job, {
    skipEcho = false,
    reason = null,
    ambiguity = null,
  } = {}) {
    let current = queue.read(job.agentName, job.pane, job.id) || job;
    if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;

    if (!skipEcho && await exactEcho(current)) return acknowledge(current, "late-echo-before-unverified");
    current = queue.read(current.agentName, current.pane, current.id) || current;
    if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;
    if (!skipEcho && await exactEcho(current)) return acknowledge(current, "late-echo-before-unverified");
    current = queue.read(current.agentName, current.pane, current.id) || current;
    if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;

    const preEnterFence = current.status === "submitting";
    const lateEchoWatchUntil = (!skipEcho && !reason && !ambiguity
      && current.kind === "slash"
      && current.status === "submitted"
      && current.echoCursor
      && typeof agent.waitForSlashReceipt === "function")
      ? Number(current.submittedAt || current.createdAt || now()) + LATE_ECHO_WATCH_MS
      : null;
    const terminal = queue.update(current, {
      status: DELIVERED_UNVERIFIED_STATE,
      draftOwned: false,
      terminalAt: now(),
      nextAttemptAt: null,
      unverifiedNoticeSentAt: null,
      unverifiedNoticeNextAttemptAt: lateEchoWatchUntil ?? now(),
      ...(lateEchoWatchUntil ? {
        lateEchoWatchUntil,
        noticeSentAt: current.noticeSentAt || now(),
      } : {}),
      ...(ambiguity || preEnterFence ? {
        metadata: { deliveryAmbiguity: ambiguity || "submitting-fence" },
      } : {}),
      lastReason: reason || (lateEchoWatchUntil
        ? "slash lane released after 60 seconds; the exact command receipt is still watched for until the 60-minute mark"
        : preEnterFence
          ? "pre-Enter submit fence has no exact receipt after 60 minutes; physical delivery remains unverified"
          : "submit attempt has no exact JSONL receipt after 60 minutes; delivery remains unverified"),
    });
    queueEvent(terminal, DELIVERED_UNVERIFIED_STATE);
    if (lateEchoWatchUntil) {
      const queuedBehind = queue.list(terminal.agentName, terminal.pane)
        .filter((other) => other.id !== terminal.id && !TERMINAL_DELIVERY_STATES.has(other.status))
        .length;
      await notify(terminal, "stalled", { queuedBehind }).catch((error) =>
        log(`delivery broker watch notice failed for ${terminal.id}: ${error.message}`));
      return terminal;
    }
    return notifyTerminal(terminal);
  }

  return { terminalizeUnverified, reconcileRecoveredCancellationTerminals };
}
