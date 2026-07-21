// Delivery notices: the broker's Discord-facing stall/blocked/terminal
// reporting. Notices are one-shot per job (noticeSentAt) and durable-retrying
// for terminal outcomes (unverifiedNoticeAttempts); a recovered job closes
// the loop through the acknowledge path. Channel resolution is best-effort:
// a missing bound channel parks the notice instead of dropping it.

import { DELIVERED_UNVERIFIED_STATE, isNotSentDeliveryJob } from "./delivery-queue.mjs";

const NOTICE_AFTER_MS = 10_000;

/** WHAT: Maps one durable blocked delivery to engine-neutral copy. WHY: Prevents a Claude wake from being mislabeled as a Codex composer wait. */
export function blockedDeliveryNotice(job) {
  const reason = String(job?.lastReason || "").replace(/^wake-refused:/u, "");
  const detail = reason === "memory-critical"
    ? "värden har kritisk minnespress"
    : reason === "memory-blocked" || reason === "memory-reserve-floor"
      ? "värden saknar säker minnesmarginal"
      : reason === "guard-state-stale"
        ? "minnesvaktens mätning är för gammal"
        : reason.startsWith("identity-")
          ? "den installerade release-identiteten kan inte verifieras"
          : "panelen är inte redo för säker leverans";
  return "⚠️ Meddelandet är säkert köat men panelen kan inte ta emot det ännu: "
    + `${detail}. Det ligger kvar över omstarter och skickas i ordning när spärren har släppt.`;
}

/** WHAT: Builds the broker's blocked/terminal notice operations. WHY: Keeps Discord reporting out of the delivery loop. */
export function createDeliveryNotices({
  queue,
  now,
  notify,
  log,
  blockedRetryMs,
  resolveNotificationChannel = null,
}) {
  /** WHAT: Posts one blocked notice per job after its grace window. WHY: Keeps stalls visible without a notification drip. */
  async function maybeNotifyBlocked(job) {
    if (job.noticeSentAt || now() - Number(job.createdAt || 0) < NOTICE_AFTER_MS) return job;
    const noticed = queue.update(job, { noticeSentAt: now() });
    await notify(noticed, "blocked").catch((error) =>
      log(`delivery broker blocked notice failed for ${noticed.id}: ${error.message}`));
    return noticed;
  }

  /** WHAT: Maps a terminal job to its notice kind. WHY: Separates unverified submits from not-sent refusals. */
  function terminalNoticeKind(job) {
    if (job.status === DELIVERED_UNVERIFIED_STATE) return "unverified";
    if (isNotSentDeliveryJob(job)) return "not-sent";
    return null;
  }

  /** WHAT: Posts a terminal notice with durable retry and channel resolution. WHY: Prevents a lost warning from silently dropping a job's fate. */
  async function notifyTerminal(initialJob) {
    let current = queue.read(initialJob.agentName, initialJob.pane, initialJob.id) || initialJob;
    const noticeKind = terminalNoticeKind(current);
    if (!noticeKind || current.unverifiedNoticeSentAt) return current;
    current = queue.update(current, {
      unverifiedNoticeAttempts: Number(current.unverifiedNoticeAttempts || 0) + 1,
      unverifiedNoticeNextAttemptAt: null,
    });
    if (!current.metadata?.channelId && typeof resolveNotificationChannel === "function") {
      let channelId = null;
      try {
        channelId = await resolveNotificationChannel(current);
      } catch (error) {
        log(`delivery broker notification channel lookup failed for ${current.id}: ${error.message}`);
      }
      if (!channelId) {
        const unavailable = queue.update(current, {
          unverifiedNoticeNextAttemptAt: now() + blockedRetryMs(current),
          unverifiedNoticeLastReason: "no Discord channel is currently bound to the target pane",
        });
        log(`delivery broker terminal notice pending for ${unavailable.id}: no bound Discord channel`);
        return unavailable;
      }
      current = queue.update(current, {
        metadata: { channelId: String(channelId) },
        unverifiedNoticeLastReason: null,
      });
    }
    try {
      await notify(current, noticeKind);
      return queue.update(current, {
        unverifiedNoticeSentAt: now(),
        unverifiedNoticeNextAttemptAt: null,
        unverifiedNoticeLastReason: null,
      });
    } catch (error) {
      const failed = queue.update(current, {
        unverifiedNoticeNextAttemptAt: now() + blockedRetryMs(current),
        unverifiedNoticeLastReason: error.message,
      });
      log(`delivery broker terminal notice failed for ${failed.id}: ${error.message}`);
      return failed;
    }
  }

  return { maybeNotifyBlocked, notifyTerminal, terminalNoticeKind };
}
