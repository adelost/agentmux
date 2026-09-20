// Delivery notices: the broker's Discord-facing stall/blocked/terminal
// reporting. Notices are one-shot per job (noticeSentAt) and durable-retrying
// for terminal outcomes (unverifiedNoticeAttempts); a recovered job closes
// the loop through the acknowledge path. Channel resolution is best-effort:
// a missing bound channel parks the notice instead of dropping it.

import { DELIVERED_UNVERIFIED_STATE, isNotSentDeliveryJob } from "./delivery-queue.mjs";
import { deliveryBlockerDetail } from "./delivery-handoff.mjs";

const NOTICE_AFTER_MS = 10_000;

/** WHAT: Maps one durable blocked delivery to engine-neutral copy. WHY: Prevents a Claude wake from being mislabeled as a Codex composer wait. */
export function blockedDeliveryNotice(job) {
  const reason = String(job?.lastReason || "").replace(/^wake-refused:/u, "");
  const detail = reason.startsWith("context-cost:")
    ? `kostnadsskyddet stoppar leveransen (${reason}). Ingen ny automatisk compact görs efter ett misslyckat försök`
    : reason === "memory-critical"
    ? "värden har kritisk minnespress"
    : reason === "memory-blocked" || reason === "memory-reserve-floor"
      ? "värden saknar säker minnesmarginal"
      : reason === "guard-state-stale"
        ? "minnesvaktens mätning är för gammal"
        : reason.startsWith("identity-")
          ? `release-identiteten är fel: ${deliveryBlockerDetail(job)}`
          : "panelen är inte redo för säker leverans";
  return "⚠️ Meddelandet är säkert köat men panelen kan inte ta emot det ännu: "
    + `${detail}. Det ligger kvar över omstarter och skickas i ordning när spärren har släppt.`;
}

/** WHAT: Maps a broker notice state to its Discord copy, or null for an unknown state. WHY: Keeps delivery wording out of bridge startup wiring. */
export function deliveryStateNotice(job, state, extra = {}) {
  if (state === "stalled") {
    const behind = Number(extra?.queuedBehind || 0);
    return "⚠️ Meddelandet skickades in till panelen men har inte fått något historikkvitto ännu " +
      "(panelen verkar upptagen med en lång tur). AMUX bevakar vidare och skickar inte om det, " +
      "för att inte skapa en dubblett." +
      (behind > 0 ? ` ${behind} meddelande(n) väntar i kö bakom det.` : "");
  }
  if (state === "blocked") return blockedDeliveryNotice(job);
  if (state === "recovered") return "✅ Det tidigare blockerade kömeddelandet har nu levererats.";
  if (state === "unverified") {
    return job.metadata?.deliveryAmbiguity === "submitting-fence"
      ? "⚠️ Leveransen stannade mellan den durabla submit-fencen och slutkvittot. Enter kan ha skickats; " +
        "AMUX vet inte säkert och skickar därför inte om. Kontrollera agenten och composern om instruktionen är kritisk."
      : "⚠️ Meddelandet lämnade composern men fick inget exakt historikkvitto inom en timme. " +
        "AMUX skickar inte om det eftersom det kan skapa en dubblett; kontrollera agenthistoriken om instruktionen är kritisk.";
  }
  if (state === "not-sent") {
    return job.metadata?.deliveryCancellation === "sender-request"
      ? "⚠️ Meddelandet avbröts före submit och skickades inte. Composern lämnades orörd; skicka en ny instruktion om arbetet ändå behövs."
      : "⚠️ Meddelandet skickades inte. Composern förblev osäker för länge eller efter för många försök, så AMUX har stoppat automatiken " +
        "för att inte skriva över eller blanda innehåll. Kontrollera/rensa composern och skicka instruktionen igen om den fortfarande behövs.";
  }
  return null;
}

/** WHAT: Builds the broker's notify callback that posts state copy to the job's Discord channel. WHY: Prevents a notice from vanishing when no channel is bound; the throw lets the broker retry. */
export function createDiscordDeliveryNotify({ discord, resolveChannel }) {
  return async (job, state, extra = {}) => {
    if (!discord) return;
    const channelId = job.metadata?.channelId || resolveChannel(job);
    if (!channelId) throw new Error(`no Discord channel bound to ${job.agentName}:${job.pane}`);
    const text = deliveryStateNotice(job, state, extra);
    if (text) await discord.send(channelId, text);
  };
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
    if (Number(job.blockedNoticeNextAttemptAt || 0) > now()) return job;
    const attempted = queue.update(job, { blockedNoticeAttempts: Number(job.blockedNoticeAttempts || 0) + 1 });
    try {
      await notify(attempted, "blocked");
      return queue.update(attempted, { noticeSentAt: now(), blockedNoticeNextAttemptAt: null,
        blockedNoticeLastReason: null });
    } catch (error) {
      log(`delivery broker blocked notice failed for ${job.id}: ${error.message}`);
      return queue.update(attempted, { blockedNoticeNextAttemptAt: now() + blockedRetryMs(attempted),
        blockedNoticeLastReason: error.message });
    }
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
