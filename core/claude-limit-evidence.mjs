// Shared exact-session Claude quota evidence, without filesystem dependencies.

import { CLAUDE_TERMINAL_STOP_REASONS, isClaudeTaskNotification } from "./claude-turn-lifecycle.mjs";

// Claude's stop texts. The spend-limit form is what a plan stop says while
// paid usage is off or capped; with only "session|usage" recognized, no stop
// was resumed or announced for two weeks (lsrc:1, 2026-09-28, 02:48 to 06:50):
//   You've hit your weekly limit · resets Sep 30, 9am (Europe/Stockholm)
//   You've hit your monthly spend limit · raise it at … · your session limit resets 3:10am (Europe/Stockholm)
const PLAN_STOP_TEXT = /^You(?:'|’)ve hit your (session|usage|weekly) limit(?:\s*·\s*resets\s+(.+?))?\s*$/iu;
const SPEND_STOP_TEXT = /^You(?:'|’)ve hit your monthly spend limit\b/iu;
const SPEND_STOP_WINDOW = /·\s*your (session|weekly) limit resets\s+(.+?)\s*$/iu;

// Claude Code warns the model before it cuts a turn at the limit, and lifts the
// warning if usage goes on. An agent that obeys ends its own turn, so no stop
// banner is written and the note is the only evidence of the stop (claw:2,
// 2026-10-19 08:04Z: no recovery, no idle alarm, 33 min idle after Claude S had room).
const GRACE_NOTE = /^\[(Usage limit reached); a short grace allowance remains\b/u;
const LIFTED_NOTE = /^\[Earlier usage-limit notes no longer apply\b/u;
const LOCAL_COMMAND = /^(?:\/|<(?:command-name|command-message|command-args|local-command-(?:stdout|stderr|caveat))>)/u;

/** WHAT: Reads Claude Code's limit note to the model: "grace", "lifted" or null. WHY: Keeps the note apart from text a person or tool wrote. */
export function claudeLimitNote(event) {
  if (event?.type !== "user" || event.isMeta !== true || typeof event.message?.content !== "string") return null;
  const text = event.message.content.trim();
  return GRACE_NOTE.test(text) ? "grace" : LIFTED_NOTE.test(text) ? "lifted" : null;
}

/** DTO: Any Claude plan-stop banner on a screen, for pane status and compact refusals. */
export const CLAUDE_STOP_BANNER = /You(?:'|’)ve hit your (?:session|usage|weekly|monthly spend) limit/iu;

/**
 * WHAT: Reads the stopped window and its displayed reset from one exact Claude stop text.
 * WHY: Keeps every current wording of a plan stop able to start recovery.
 */
export function claudeLimitFromText(text) {
  const trimmed = String(text || "").trim();
  const plan = PLAN_STOP_TEXT.exec(trimmed);
  if (plan) return { kind: plan[1].toLowerCase(), reset: plan[2] || null };
  if (!SPEND_STOP_TEXT.test(trimmed)) return null;
  const window = SPEND_STOP_WINDOW.exec(trimmed);
  return window ? { kind: window[1].toLowerCase(), reset: window[2] } : { kind: "usage", reset: null };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const RESET_TEXT = /^(?:([a-z]{3})[a-z]*\s+(\d{1,2}),\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?$/iu;

const ACTIONABLE_EVENT_TYPES = new Set(["assistant", "user"]);

/** WHAT: Reads one assistant limit text. WHY: Keeps quoted tool errors out of session-limit evidence. */
export function claudeLimitEventText(event) {
  if (event?.type !== "assistant" || !Array.isArray(event.message?.content)) return null;
  const blocks = event.message.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean);
  return blocks.length === 1 ? blocks[0] : null;
}

function isActionableAfterLimit(event) {
  if (!ACTIONABLE_EVENT_TYPES.has(event?.type)) return false;
  if (event.type === "user") {
    if (isClaudeTaskNotification(event)) return false;
    return typeof event.message?.content === "string"
      || Array.isArray(event.message?.content);
  }
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return content.some((block) => block?.type === "tool_use"
    || (block?.type === "text" && String(block.text || "").trim()));
}

const endsTurn = (event) => event?.type === "assistant" && CLAUDE_TERMINAL_STOP_REASONS.has(event.message?.stop_reason);

// After a grace note come the agent's own wrap-up, tool results, a compaction and
// slash commands; only input someone sent shows that the pane works again.
function isNewPromptAfterNote(event) {
  if (event?.type !== "user" || event.isMeta || event.isCompactSummary || isClaudeTaskNotification(event)) return false;
  const content = event.message?.content;
  const texts = typeof content === "string" ? [content]
    : Array.isArray(content) ? content.filter((block) => block?.type === "text").map((block) => String(block.text || "")) : [];
  return texts.some((text) => text.trim() && !LOCAL_COMMAND.test(text.trim()));
}

function zonedParts(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epochMs));
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function zonedEpoch({ year, month, day, hour, minute }, timeZone) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let candidate = wallAsUtc;
  for (let pass = 0; pass < 2; pass++) {
    const rendered = zonedParts(candidate, timeZone);
    const renderedAsUtc = Date.UTC(
      Number(rendered.year), Number(rendered.month) - 1, Number(rendered.day),
      Number(rendered.hour), Number(rendered.minute), Number(rendered.second),
    );
    candidate = wallAsUtc - (renderedAsUtc - candidate);
  }
  return candidate;
}

/**
 * WHAT: Parses Claude's displayed local reset into an absolute instant.
 * WHY: Keeps clock fallback from guessing across time zones or day rollover.
 */
export function parseClaudeLimitResetAt(text, observedAtMs) {
  const shown = claudeLimitFromText(text)?.reset;
  const reset = shown && RESET_TEXT.exec(shown.trim());
  if (!reset) return null;

  const timeZone = reset[6]
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || "UTC";
  let hour = Number(reset[3]) % 12;
  if (reset[5].toLowerCase() === "pm") hour += 12;
  const minute = Number(reset[4] || 0);
  const month = reset[1] ? MONTHS.indexOf(reset[1].toLowerCase()) + 1 : null;
  if (!Number.isFinite(observedAtMs) || minute > 59 || month === 0) return null;

  let dateParts;
  try {
    const observed = zonedParts(observedAtMs, timeZone);
    dateParts = {
      year: Number(observed.year),
      month: month ?? Number(observed.month),
      day: month ? Number(reset[2]) : Number(observed.day),
      hour,
      minute,
    };
  } catch {
    return null;
  }

  let candidate;
  try { candidate = zonedEpoch(dateParts, timeZone); }
  catch { return null; }
  if (month) {
    // A dated reset before the stop is next year's date (a December stop resetting in January).
    return candidate < observedAtMs - 30_000 ? zonedEpoch({ ...dateParts, year: dateParts.year + 1 }, timeZone) : candidate;
  }
  if (candidate < observedAtMs - 30_000) {
    const nextDate = new Date(Date.UTC(dateParts.year, dateParts.month - 1, dateParts.day + 1));
    candidate = zonedEpoch({
      year: nextDate.getUTCFullYear(),
      month: nextDate.getUTCMonth() + 1,
      day: nextDate.getUTCDate(),
      hour,
      minute,
    }, timeZone);
  }
  return Number.isFinite(candidate) ? candidate : null;
}

/**
 * WHAT: Extracts one unsuperseded limit receipt from append-only session events.
 * WHY: Prevents screen text or stale watchdog observations from authorizing restarts.
 */
export function activeClaudeLimitReceiptFromEvents(events, {
  sessionId,
  sessionPath = null,
} = {}) {
  if (!sessionId || !Array.isArray(events)) return null;
  let found = null;
  for (let index = events.length - 1; index >= 0; index--) {
    const note = claudeLimitNote(events[index]);
    if (note === "lifted") return null;
    // The grace note names no window and no reset; the quota reading decides when the pane resumes.
    const text = note === "grace" ? GRACE_NOTE.exec(events[index].message.content.trim())[1] : claudeLimitEventText(events[index]);
    const limit = note === "grace" ? { kind: "usage", reset: null } : text && claudeLimitFromText(text);
    if (!limit) continue;
    const event = events[index];
    if (!event.uuid || !event.timestamp
      || (event.sessionId && event.sessionId !== sessionId)
      || (event.session_id && event.session_id !== sessionId)) return null;
    const observedAt = Date.parse(event.timestamp);
    if (!Number.isFinite(observedAt)) return null;
    found = { index, event, text, limit, observedAt, resumedBy: note ? isNewPromptAfterNote : isActionableAfterLimit };
    break;
  }
  if (!found) return null;
  const after = events.slice(found.index + 1);
  // Within the grace the agent is still finishing; it has stopped once its turn ends.
  if (found.resumedBy === isNewPromptAfterNote && !after.some(endsTurn)) return null;
  if (after.some(event =>
    (event.sessionId && event.sessionId !== sessionId)
    || (event.session_id && event.session_id !== sessionId)
    || found.resumedBy(event))) return null;

  return Object.freeze({
    engine: "claude",
    sessionId,
    sessionPath,
    limitEventId: found.event.uuid,
    limitKind: found.limit.kind,
    // Where the stop was read: Claude's grace note or its stop banner.
    stop: found.resumedBy === isNewPromptAfterNote ? "grace-note" : "banner",
    text: found.text,
    observedAt: found.observedAt,
    resetAt: parseClaudeLimitResetAt(found.text, found.observedAt),
  });
}
