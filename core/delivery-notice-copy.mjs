// Human copy for delivery notices in Discord.
//
// Mattias (2026-09-23): "Jättedålig ux här... Kan ni därefter fixa uxen så
// det är begripligt?" Every notice says what happened, to which message and
// by whom, why in everyday words, and what happens next. Internal words
// (see NOTICE_BANNED_WORDS) never appear in the copy; a test enforces it.

/** WHAT: Names the internal words no notice may contain. WHY: Keeps delivery machinery out of what a human reads. */
export const NOTICE_BANNED_WORDS = Object.freeze([
  "submit", "composer", "jsonl", "fence", "fifo", "broker", "kvitto", "receipt",
]);

const GROUP_LIST_MAX = 10;
const PREVIEW_CHARS = 50;

const target = (job) => `${job.agentName}:${job.pane}`;

/** WHAT: Formats a wall-clock time as HH:MM. WHY: Keeps notice times in the reader's clock. */
export function clockTime(ms, timeZone) {
  return new Date(ms).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone });
}

/** WHAT: Names a wait as "12 minutes". WHY: Keeps the wait from reading as two phrases after "after". */
export function waitPhrase(ms) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "hour" : "hours"}`;
}

/** WHAT: Formats a duration as "12 min" or "3 h". WHY: Keeps give-up copy short. */
function shortDuration(ms) {
  const minutes = Math.max(1, Math.round(Number(ms || 0) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/** WHAT: Extracts the first readable words of a queued message. WHY: Keeps the reader from guessing which message a notice concerns when no reply is possible. */
export function messagePreview(job, max = PREVIEW_CHARS) {
  const raw = String(job?.verifyText || job?.text || "");
  const lines = raw.split("\n").map((line) => line.trim());
  const hasImage = lines.some((line) => line.startsWith("[image attached:"));
  const words = lines
    .filter((line) => line && !line.startsWith("[image attached:"))
    .join(" ")
    .replace(/\[from [^\]]+\]\s*/gu, "")
    .replace(/^\[transcribed voice[^\]]*\]\s*/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  const text = words || (hasImage ? "(image)" : "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** WHAT: Names who removed a message. WHY: Keeps the broker's own name out of human copy. */
function actorName(requestedBy) {
  const actor = String(requestedBy || "").trim();
  if (!actor || actor === "unknown sender") return "Someone";
  return actor === "delivery-broker" ? "amux" : actor;
}

const REASON_WORDS = [
  // Prefixes of ENGINE_START_REFUSED (engine-start-guard) and PANE_LAYOUT_UNSAFE (pane-provisioning).
  [/^engine start refused:/u,
    () => "the pane's session already runs in another process or pane, so amux does not start it twice"],
  [/^pane layout unsafe:/u,
    () => "amux cannot trust the pane numbering in tmux right now, so nothing is started or added"],
  [/^Codex work blocked: selected (\S+), running (\S+);/u,
    (m) => `the pane runs ${m[2]} but is set to ${m[1]}`],
  [/^Codex work blocked:/u,
    () => "a model change on the pane failed, so it takes no work until the model is fixed"],
  [/^context-cost:/u, () => "the pane is large and has waited long, so it is compacted first"],
  [/^memory-(critical|blocked|reserve-floor)/u, () => "the computer is low on memory right now"],
  [/^guard-state-stale/u, () => "the memory check is too old to trust right now"],
  [/^identity-/u, () => "the amux installation cannot be verified"],
  [/composer is not empty|differs from composer|composer-foreign/u,
    () => "the pane's input field already holds other text, and amux does not overwrite it"],
  [/durable draft is not visible|provisional paste|not currently observable/u,
    () => "amux cannot see the text it started in the pane and does not type it twice"],
  [/busy|arbetar/u, () => "the pane is busy with something else"],
  [/JSONL|receipt/u, () => "the pane has not confirmed that it got it"],
];

/** WHAT: Formats a durable delivery reason into everyday English. WHY: Names the real blocker instead of a generic "not arrived yet". */
export function plainReason(lastReason) {
  const original = String(lastReason || "").trim();
  const reason = original.replace(/^wake-refused:/u, "").replace(/^not sent: /u, "");
  for (const [pattern, words] of REASON_WORDS) {
    const match = reason.match(pattern);
    if (match) return words(match);
  }
  if (original.startsWith("wake-refused:")) return "the pane could not be started";
  return reason || "unknown cause";
}

/** WHAT: Formats the waiting notice, optionally with the wait so far. WHY: One edited notice stays current instead of a stack of alerts. */
export function waitingNotice(job, { waitedMs = 0 } = {}) {
  const hours = Math.floor(Number(waitedMs || 0) / 3_600_000);
  const waited = hours > 0 ? ` (waited ${hours} h)` : "";
  return `${target(job)} has not got this yet${waited}. Cause: ${plainReason(job.lastReason)}. `
    + "It is sent automatically when it can be.";
}

/** WHAT: Formats the busy-turn notice after the message was entered. WHY: Keeps the entered-message status distinct from delivery. */
export function busyNotice(job, { queuedBehind = 0 } = {}) {
  const behind = Number(queuedBehind || 0) > 0 ? ` ${queuedBehind} more wait behind it.` : "";
  return `${target(job)} has this but has not confirmed it yet, because the pane is busy with something else. `
    + `amux does not send it again, so it is not doubled.${behind}`;
}

/** WHAT: Formats the delivered outcome that replaces a waiting notice. WHY: Keeps the delivery confirmation in the same notice. */
export function deliveredNotice(job, { timeZone } = {}) {
  const at = Number(job.acknowledgedAt || Date.now());
  const wait = waitPhrase(at - Number(job.createdAt || at));
  return `${target(job)} got this at ${clockTime(at, timeZone)}${wait ? `, after ${wait}` : ""}.`;
}

/** WHAT: Formats one not-sent outcome by its cause. WHY: Keeps the cause and next step visible. */
export function notSentNotice(job) {
  if (job.metadata?.deliveryCancellation === "sender-request") {
    const why = String(job.cancelRequestedReason || "").trim();
    return `Not sent to ${target(job)}. ${actorName(job.cancelRequestedBy)} removed it`
      + (why ? `: “${why}”.` : ".");
  }
  if (job.metadata?.deliveryRejection === "engine-rejected") {
    return `Not sent to ${target(job)}. The pane rejected the command: ${plainReason(job.lastReason)}.`;
  }
  if (job.metadata?.deliveryTarget === "not-ingesting") {
    return `Not sent to ${target(job)}. The pane stopped taking messages. `
      + "Send it again when the pane answers.";
  }
  const attempts = Math.max(1, Number(job.attempts || 0));
  const spent = shortDuration(Number(job.terminalAt || Date.now())
    - Number(job.firstAttemptAt || job.createdAt || Date.now()));
  return `Not sent to ${target(job)} after ${attempts} ${attempts === 1 ? "attempt" : "attempts"} in ${spent}. `
    + `Cause: ${plainReason(job.lastReason)}. Send it again once that is fixed.`;
}

/** WHAT: Formats several same-outcome not-sent jobs as one list. WHY: Keeps grouped cancellation details in one notice. */
export function notSentGroupNotice(jobs, { timeZone } = {}) {
  const first = jobs[0];
  const count = jobs.length;
  const why = String(first.cancelRequestedReason || "").trim();
  const head = first.metadata?.deliveryCancellation === "sender-request"
    ? `${count} messages to ${target(first)} were not sent. `
      + `${actorName(first.cancelRequestedBy)} removed them${why ? `: “${why}”.` : "."}`
    : `${count} messages to ${target(first)} were not sent. Cause: ${plainReason(first.lastReason)}.`;
  const shown = jobs.slice(0, GROUP_LIST_MAX)
    .map((job) => `• ${clockTime(Number(job.createdAt || 0), timeZone)} ${messagePreview(job)}`);
  const more = count > GROUP_LIST_MAX ? [`+${count - GROUP_LIST_MAX} more`] : [];
  return [head, ...shown, ...more].join("\n");
}

/** WHAT: Formats the cannot-confirm outcome. WHY: Prevents uncertain delivery from being sent twice. */
export function uncertainNotice(job) {
  return `${target(job)} may have got this, but amux cannot confirm it. `
    + "It is not sent again, so it is not doubled. See the reply above.";
}

/** WHAT: Adds a quote of the message when the notice cannot reply to it. WHY: Tells the reader which message the notice concerns. */
export function withMessageQuote(text, job) {
  const preview = messagePreview(job);
  return preview ? `${text}\n> ${preview}` : text;
}
