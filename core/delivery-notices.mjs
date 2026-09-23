// Delivery notices: the broker's Discord-facing wait/outcome reporting.
// One notice per event and recipient. A waiting notice replies to the human's
// own message and later outcomes EDIT it (waiting -> delivered). Several
// same-outcome not-sent jobs for one pane within two minutes become one list.
// Messages sent by agents or by amux itself never reach the human channel; a
// sending agent hears about outcomes it did not cause itself. Terminal
// notices retry durably; a missing bound channel parks instead of dropping.

import { DELIVERED_UNVERIFIED_STATE, isNotSentDeliveryJob } from "./delivery-queue.mjs";
import { parseSenderAddress } from "./sender-detect.mjs";
import {
  busyNotice, deliveredNotice, messagePreview, notSentGroupNotice, notSentNotice,
  uncertainNotice, waitingNotice, withMessageQuote,
} from "./delivery-notice-copy.mjs";

const NOTICE_AFTER_MS = 60_000;
// A parked head's notice is refreshed after 1 h, then 2 h, 4 h ... since the last one.
const BLOCKED_REMINDER_MS = 60 * 60_000;
// A not-sent list waits for 30 s of quiet, at most 2 min from its first job.
const GROUP_QUIET_MS = 30_000;
const GROUP_WINDOW_MS = 2 * 60_000;
const MACHINE_SOURCES = new Set([
  "auto-compact", "delivery-recovery", "dream", "drift-guard", "model-watch", "suggestions-watchdog",
]);

/** WHAT: Finds the agent pane that sent a job, if any. WHY: Routes agent-to-agent outcomes to the sender instead of the human. */
export function agentSender(job) {
  const sender = parseSenderAddress(job?.metadata?.sender);
  return sender && sender.key !== `${job.agentName}:${job.pane}` ? sender : null;
}

/** WHAT: Checks whether a human wrote the job. WHY: The human channel only hears about the human's own messages. */
export function isHumanMessage(job) {
  return !MACHINE_SOURCES.has(job?.source) && !agentSender(job);
}

/** WHAT: Renders the waiting notice. WHY: Keeps the historical name for callers and tests. */
export function blockedDeliveryNotice(job, extra = {}) {
  return waitingNotice(job, extra);
}

/** WHAT: Maps a broker notice state to its Discord copy, or null for an unknown state. WHY: Keeps delivery wording out of bridge startup wiring. */
export function deliveryStateNotice(job, state, extra = {}) {
  if (state === "stalled") return busyNotice(job, extra);
  if (state === "blocked") return waitingNotice(job, extra);
  if (state === "recovered") return deliveredNotice(job, extra);
  if (state === "unverified") return uncertainNotice(job);
  if (state === "not-sent") return notSentNotice(job);
  if (state === "not-sent-group") return notSentGroupNotice(extra.jobs?.length ? extra.jobs : [job], extra);
  return null;
}

/**
 * WHAT: Builds the broker's notify callback: reply to the human's message, or edit the notice already posted for it.
 * WHY: Keeps each event in one notice beside its message; a throw on a missing channel lets the broker retry.
 * Returns the notice reference { channelId, messageId, quoted } or null when nothing was posted.
 */
export function createDiscordDeliveryNotify({ discord, resolveChannel, timeZone }) {
  return async (job, state, extra = {}) => {
    if (!discord || !isHumanMessage(job)) return null;
    const text = deliveryStateNotice(job, state, { timeZone, ...extra });
    if (!text) return null;
    const group = state === "not-sent-group";
    const ref = group ? null : job.metadata?.noticeRef;
    if (ref?.messageId && typeof discord.editMessage === "function") {
      try {
        await discord.editMessage(ref.channelId, ref.messageId, ref.quoted ? withMessageQuote(text, job) : text);
        return ref;
      } catch { /* the notice was deleted: post a new one below */ }
    }
    const channelId = job.metadata?.channelId || resolveChannel?.(job);
    if (!channelId) throw new Error(`no Discord channel bound to ${job.agentName}:${job.pane}`);
    const origin = group ? null : job.metadata?.messageId;
    if (origin && typeof discord.replyTo === "function") {
      try {
        const reply = await discord.replyTo(channelId, origin, text);
        return { channelId: String(channelId), messageId: reply?.id || null, quoted: false };
      } catch { /* the original was deleted: quote it instead */ }
    }
    const posted = await discord.send(channelId, group ? text : withMessageQuote(text, job));
    return { channelId: String(channelId), messageId: posted?.id || null, quoted: !group };
  };
}

/** WHAT: Builds the broker's waiting/terminal notice operations. WHY: Keeps Discord reporting out of the delivery loop. */
export function createDeliveryNotices({
  queue,
  now,
  notify,
  log,
  blockedRetryMs,
  resolveNotificationChannel = null,
}) {
  const reread = (job) => queue.read(job.agentName, job.pane, job.id) || job;

  /** WHAT: Stores where a job's notice lives. WHY: Lets later outcomes edit it instead of stacking alerts. */
  function rememberNotice(job, ref) {
    if (!ref?.messageId || ref.messageId === job.metadata?.noticeRef?.messageId) return job;
    return queue.update(reread(job), { metadata: { noticeRef: ref } });
  }

  /** WHAT: Posts or edits one notice and remembers it. WHY: Gives every notice for a job one place. */
  async function notifyAndRemember(job, state, extra = {}) {
    return rememberNotice(job, await notify(job, state, extra));
  }

  /** WHAT: Refreshes a head still parked after its reminder interval. WHY: Keeps an hours-long wait current without a per-poll drip. */
  async function maybeRemindBlocked(job) {
    if (!job.metadata?.preSubmitPark) return job;
    const count = Number(job.blockedReminderCount || 0);
    const lastAt = Number(job.blockedReminderAt || job.noticeSentAt);
    if (now() - lastAt < BLOCKED_REMINDER_MS * 2 ** count) return job;
    try {
      job = await notifyAndRemember(job, "blocked", { waitedMs: now() - Number(job.createdAt || now()) });
    } catch (error) {
      log(`delivery broker blocked reminder failed for ${job.id}: ${error.message}`);
      return job;
    }
    return queue.update(reread(job), { blockedReminderAt: now(), blockedReminderCount: count + 1 });
  }

  /** WHAT: Posts one waiting notice per job after its grace window, then refreshes it while parked. WHY: Keeps waits visible without a notification drip. */
  async function maybeNotifyBlocked(job) {
    if (job.noticeSentAt) return maybeRemindBlocked(job);
    if (now() - Number(job.createdAt || 0) < NOTICE_AFTER_MS) return job;
    if (Number(job.blockedNoticeNextAttemptAt || 0) > now()) return job;
    let attempted = queue.update(job, { blockedNoticeAttempts: Number(job.blockedNoticeAttempts || 0) + 1 });
    try {
      attempted = await notifyAndRemember(attempted, "blocked");
      return queue.update(reread(attempted), { noticeSentAt: now(), blockedNoticeNextAttemptAt: null,
        blockedNoticeLastReason: null });
    } catch (error) {
      log(`delivery broker blocked notice failed for ${job.id}: ${error.message}`);
      return queue.update(reread(attempted), { blockedNoticeNextAttemptAt: now() + blockedRetryMs(attempted),
        blockedNoticeLastReason: error.message });
    }
  }

  /** WHAT: Maps a terminal job to its notice kind. WHY: Separates unverified submits from not-sent refusals. */
  function terminalNoticeKind(job) {
    if (job.status === DELIVERED_UNVERIFIED_STATE) return "unverified";
    if (isNotSentDeliveryJob(job)) return "not-sent";
    return null;
  }

  /** WHAT: Checks whether a not-sent notice may join a list. WHY: A job with its own notice edits that one instead. */
  const groupable = (job) => terminalNoticeKind(job) === "not-sent"
    && isHumanMessage(job) && !job.metadata?.noticeRef?.messageId;

  const markSent = (job, reason = null) => queue.update(reread(job), {
    unverifiedNoticeSentAt: now(), unverifiedNoticeNextAttemptAt: null, unverifiedNoticeLastReason: reason,
  });

  const markRetry = (job, reason) => queue.update(reread(job), {
    unverifiedNoticeNextAttemptAt: now() + blockedRetryMs(job), unverifiedNoticeLastReason: reason,
  });

  /** WHAT: Reports an agent's or amux's own terminal job. WHY: The sender hears outcomes it did not cause; the human hears nothing. */
  function settleMachineTerminal(job, kind) {
    const sender = agentSender(job);
    const selfCancelled = job.metadata?.deliveryCancellation === "sender-request"
      && String(job.cancelRequestedBy || "") === sender?.key;
    if (!sender || selfCancelled) return markSent(job, sender ? "sender cancelled it" : "not a human message");
    const outcome = kind === "unverified"
      ? "kan ha kommit fram men kunde inte bekräftas. Skicka inte om utan att läsa mottagarens historik."
      : notSentNotice(job).replace(/^🚫 /u, "");
    try {
      queue.enqueue({
        agentName: sender.session, pane: sender.pane, source: "delivery-recovery",
        text: `[AMUX leveransutfall] Ditt meddelande till ${job.agentName}:${job.pane} `
          + `(jobb ${job.id}, ”${messagePreview(job)}”): ${outcome}`,
        idempotencyKey: `delivery-outcome:${job.agentName}:${job.pane}:${job.id}`,
      });
      return markSent(job);
    } catch (error) {
      log(`delivery outcome for sender ${sender.key} pending for ${job.id}: ${error.message}`);
      return markRetry(job, error.message);
    }
  }

  /** WHAT: Resolves the Discord channel for a terminal notice. WHY: A missing bound channel parks the notice instead of dropping it. */
  async function withChannel(job) {
    if (job.metadata?.channelId || typeof resolveNotificationChannel !== "function") return job;
    let channelId = null;
    try {
      channelId = await resolveNotificationChannel(job);
    } catch (error) {
      log(`delivery broker notification channel lookup failed for ${job.id}: ${error.message}`);
    }
    if (!channelId) {
      log(`delivery broker terminal notice pending for ${job.id}: no bound Discord channel`);
      return null;
    }
    return queue.update(job, { metadata: { channelId: String(channelId) }, unverifiedNoticeLastReason: null });
  }

  /** WHAT: Posts one terminal notice with durable retry. WHY: Prevents a lost warning from silently dropping a job's fate. */
  async function sendTerminal(job, kind) {
    let current = queue.update(reread(job), {
      unverifiedNoticeAttempts: Number(job.unverifiedNoticeAttempts || 0) + 1,
      unverifiedNoticeNextAttemptAt: null,
    });
    const bound = await withChannel(current);
    if (!bound) return markRetry(current, "no Discord channel is currently bound to the target pane");
    current = bound;
    try {
      await notify(current, kind);
      return markSent(current);
    } catch (error) {
      log(`delivery broker terminal notice failed for ${current.id}: ${error.message}`);
      return markRetry(current, error.message);
    }
  }

  /** WHAT: Reports one terminal job now, or leaves a not-sent job for the list. WHY: Keeps a burst of cancellations from becoming a wall of notices. */
  async function notifyTerminal(initialJob) {
    const current = reread(initialJob);
    const kind = terminalNoticeKind(current);
    if (!kind || current.unverifiedNoticeSentAt) return current;
    if (!isHumanMessage(current)) return settleMachineTerminal(current, kind);
    if (groupable(current)) return current;
    return sendTerminal(current, kind);
  }

  /** WHAT: Names the outcome a list shares. WHY: Only identical outcomes may share one notice. */
  function outcomeKey(job) {
    const meta = job.metadata || {};
    const cause = meta.deliveryCancellation || meta.deliveryRejection || meta.deliveryTarget
      || meta.deliveryTimeout || "other";
    const why = cause === "sender-request"
      ? `${job.cancelRequestedBy || ""}\u0000${job.cancelRequestedReason || ""}` : String(job.lastReason || "");
    return `${cause}\u0000${why}\u0000${meta.channelId || ""}`;
  }

  /** WHAT: Posts every due terminal notice for one pane, listing same-outcome not-sent jobs together. WHY: Fourteen cancellations must be one notice. */
  async function flushTerminalNotices(agentName, pane) {
    const due = (queue.pendingTerminalNotices?.(agentName, pane) || [])
      .filter((job) => Number(job.unverifiedNoticeNextAttemptAt || 0) <= now());
    const groups = new Map();
    for (const job of due) {
      if (!groupable(job)) { await notifyTerminal(job); continue; }
      const key = outcomeKey(job);
      groups.set(key, [...(groups.get(key) || []), job]);
    }
    for (const jobs of groups.values()) {
      const ended = jobs.map((job) => Number(job.terminalAt || now()));
      if (now() - Math.max(...ended) < GROUP_QUIET_MS && now() - Math.min(...ended) < GROUP_WINDOW_MS) continue;
      if (jobs.length === 1) { await sendTerminal(jobs[0], "not-sent"); continue; }
      jobs.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
      const lead = await withChannel(jobs[0]);
      if (!lead) { for (const job of jobs) markRetry(job, "no Discord channel is currently bound to the target pane"); continue; }
      try {
        await notify(lead, "not-sent-group", { jobs: [lead, ...jobs.slice(1)] });
        for (const job of jobs) markSent(job);
      } catch (error) {
        log(`delivery broker grouped notice failed for ${agentName}:${pane}: ${error.message}`);
        for (const job of jobs) markRetry(job, error.message);
      }
    }
  }

  return {
    maybeNotifyBlocked, notifyTerminal, flushTerminalNotices, notifyAndRemember, terminalNoticeKind,
  };
}
