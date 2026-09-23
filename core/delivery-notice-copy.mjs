// Human copy for delivery notices in Discord.
//
// Mattias (2026-09-23): "Jättedålig ux här... Kan ni därefter fixa uxen så
// det är begripligt?" Every notice says what happened, to which message and
// by whom, why in everyday words, and what happens next. Internal words
// (see NOTICE_BANNED_WORDS) never appear in the copy; a test enforces it.

/** WHAT: Lists the internal words no notice may contain. WHY: Keeps delivery machinery out of what a human reads. */
export const NOTICE_BANNED_WORDS = Object.freeze([
  "submit", "composer", "jsonl", "fence", "fifo", "broker", "kvitto",
]);

const GROUP_LIST_MAX = 10;
const PREVIEW_CHARS = 50;

const target = (job) => `${job.agentName}:${job.pane}`;

/** WHAT: Formats a wall-clock time as HH:MM. WHY: Keeps notice times in the reader's clock. */
export function clockTime(ms, timeZone) {
  return new Date(ms).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone });
}

/** WHAT: Names a wait as "12 minuters väntan". WHY: Reads as one Swedish phrase after "efter". */
export function waitPhrase(ms) {
  const minutes = Math.max(0, Math.round(Number(ms || 0) / 60_000));
  if (minutes < 1) return null;
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minuts" : "minuters"} väntan`;
  const hours = Math.floor(minutes / 60);
  return `${hours} ${hours === 1 ? "timmes" : "timmars"} väntan`;
}

/** WHAT: Formats a duration as "12 min" or "3 h". WHY: Keeps give-up copy short. */
function shortDuration(ms) {
  const minutes = Math.max(1, Math.round(Number(ms || 0) / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`;
}

/** WHAT: Extracts the first readable words of a queued message. WHY: Tells the reader which message a notice is about when no reply is possible. */
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
  const text = words || (hasImage ? "(bild)" : "");
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** WHAT: Names who removed a message. WHY: Keeps the broker's own name out of human copy. */
function actorName(requestedBy) {
  const actor = String(requestedBy || "").trim();
  if (!actor || actor === "unknown sender") return "Någon";
  return actor === "delivery-broker" ? "amux" : actor;
}

const REASON_WORDS = [
  [/^Codex work blocked: selected (\S+), running (\S+);/u,
    (m) => `panelen kör ${m[2]} men är inställd på ${m[1]}`],
  [/^Codex work blocked:/u,
    () => "ett modellbyte på panelen misslyckades, så den tar inte emot arbete förrän modellen är rättad"],
  [/^context-cost:/u, () => "panelen är stor och har legat länge, så den compactas först"],
  [/^memory-(critical|blocked|reserve-floor)/u, () => "datorn har ont om minne just nu"],
  [/^guard-state-stale/u, () => "minneskontrollen är för gammal för att lita på just nu"],
  [/^identity-/u, () => "amux-installationen kan inte verifieras"],
  [/composer is not empty|differs from composer|composer-foreign/u,
    () => "det står redan annan text i panelens inmatningsfält, och amux skriver inte över den"],
  [/durable draft is not visible|provisional paste|not currently observable/u,
    () => "amux ser inte sin påbörjade text i panelen och skriver den inte två gånger"],
  [/busy|arbetar/u, () => "panelen arbetar med något annat"],
  [/JSONL|receipt/u, () => "panelen har inte bekräftat att den tagit emot det"],
];

/** WHAT: Translates a durable delivery reason into everyday Swedish. WHY: Names the real blocker instead of a generic "not arrived yet". */
export function plainReason(lastReason) {
  const original = String(lastReason || "").trim();
  const reason = original.replace(/^wake-refused:/u, "").replace(/^not sent: /u, "");
  for (const [pattern, words] of REASON_WORDS) {
    const match = reason.match(pattern);
    if (match) return words(match);
  }
  if (original.startsWith("wake-refused:")) return "panelen kunde inte startas";
  return reason || "okänd orsak";
}

/** WHAT: Renders the waiting notice, optionally with the wait so far. WHY: One edited notice stays current instead of a stack of alerts. */
export function waitingNotice(job, { waitedMs = 0 } = {}) {
  const hours = Math.floor(Number(waitedMs || 0) / 3_600_000);
  const waited = hours > 0 ? ` (väntat ${hours} h)` : "";
  return `⏸️ ${target(job)} har inte fått det här än${waited}. Orsak: ${plainReason(job.lastReason)}. `
    + "Det skickas automatiskt när det går.";
}

/** WHAT: Renders the busy-turn notice after the message was entered. WHY: Says why nothing happens yet and that it will not be doubled. */
export function busyNotice(job, { queuedBehind = 0 } = {}) {
  const behind = Number(queuedBehind || 0) > 0 ? ` ${queuedBehind} till väntar efter det.` : "";
  return `⏸️ ${target(job)} har fått det här men har inte bekräftat det än, eftersom panelen arbetar med något annat. `
    + `amux skickar det inte igen, för att det inte ska bli dubbelt.${behind}`;
}

/** WHAT: Renders the delivered outcome that replaces a waiting notice. WHY: Closes the loop in the same notice. */
export function deliveredNotice(job, { timeZone } = {}) {
  const at = Number(job.acknowledgedAt || Date.now());
  const wait = waitPhrase(at - Number(job.createdAt || at));
  return `✅ ${target(job)} fick det här ${clockTime(at, timeZone)}${wait ? `, efter ${wait}` : ""}.`;
}

/** WHAT: Renders one not-sent outcome by its cause. WHY: Names who or what stopped it and what to do. */
export function notSentNotice(job) {
  if (job.metadata?.deliveryCancellation === "sender-request") {
    const why = String(job.cancelRequestedReason || "").trim();
    return `🚫 Skickades inte till ${target(job)}. ${actorName(job.cancelRequestedBy)} tog bort det`
      + (why ? `: ”${why}”.` : ".");
  }
  if (job.metadata?.deliveryRejection === "engine-rejected") {
    return `🚫 Skickades inte till ${target(job)}. Panelen avvisade kommandot: ${plainReason(job.lastReason)}.`;
  }
  if (job.metadata?.deliveryTarget === "not-ingesting") {
    return `🚫 Skickades inte till ${target(job)}. Orsak: panelen har slutat ta emot meddelanden. `
      + "Skicka igen när panelen svarar igen.";
  }
  const attempts = Math.max(1, Number(job.attempts || 0));
  const spent = shortDuration(Number(job.terminalAt || Date.now())
    - Number(job.firstAttemptAt || job.createdAt || Date.now()));
  return `🚫 Skickades inte till ${target(job)} efter ${attempts} försök på ${spent}. `
    + `Orsak: ${plainReason(job.lastReason)}. Skicka igen när det är åtgärdat.`;
}

/** WHAT: Renders several same-outcome not-sent jobs as one list. WHY: Fourteen cancellations must be one notice, not fourteen. */
export function notSentGroupNotice(jobs, { timeZone } = {}) {
  const first = jobs[0];
  const count = jobs.length;
  const why = String(first.cancelRequestedReason || "").trim();
  const head = first.metadata?.deliveryCancellation === "sender-request"
    ? `🚫 ${count} meddelanden till ${target(first)} skickades inte. `
      + `${actorName(first.cancelRequestedBy)} tog bort dem${why ? `: ”${why}”.` : "."}`
    : `🚫 ${count} meddelanden till ${target(first)} skickades inte. Orsak: ${plainReason(first.lastReason)}.`;
  const shown = jobs.slice(0, GROUP_LIST_MAX)
    .map((job) => `• ${clockTime(Number(job.createdAt || 0), timeZone)} ${messagePreview(job)}`);
  const more = count > GROUP_LIST_MAX ? [`+${count - GROUP_LIST_MAX} till`] : [];
  return [head, ...shown, ...more].join("\n");
}

/** WHAT: Renders the cannot-confirm outcome. WHY: Explains why amux will not resend. */
export function uncertainNotice(job) {
  return `❓ ${target(job)} kan ha fått det här, men amux kan inte bekräfta det. `
    + "Det skickas inte igen, för att inte bli dubbelt. Se svaret ovan.";
}

/** WHAT: Adds a quote of the message when the notice cannot reply to it. WHY: Tells the reader which message the notice concerns. */
export function withMessageQuote(text, job) {
  const preview = messagePreview(job);
  return preview ? `${text}\n> ${preview}` : text;
}
