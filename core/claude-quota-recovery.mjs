// Claude quota-limit recovery evidence.
//
// A rendered "limited" banner is useful status, but it is not enough authority
// to kill and restart a pane.  This module reads Claude's append-only session
// history and returns an exact, session-bound receipt only when the newest
// actionable assistant event is the canonical quota response.  Callers can
// then resume that exact session and send a continuation turn without replaying
// the original task from the beginning.

import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import { parseJsonlWindow } from "./jsonl-reader.mjs";

export const CLAUDE_LIMIT_TEXT = /^You've hit your (session|usage) limit(?:\s*·\s*resets\s+(.+?))?\s*$/iu;

const ACTIONABLE_EVENT_TYPES = new Set(["assistant", "user"]);
const DEFAULT_LIMIT_TAIL_BYTES = 8 * 1024 * 1024;

function assistantText(event) {
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
    // Tool results after a quota response mean the previous tool lifecycle is
    // still moving. A new string prompt means a human/manual recovery already
    // superseded this limit receipt. Both make automatic restart unsafe.
    return typeof event.message?.content === "string"
      || Array.isArray(event.message?.content);
  }
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  return content.some((block) => block?.type === "tool_use"
    || (block?.type === "text" && String(block.text || "").trim()));
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
  // Resolve the zone offset twice so DST boundaries converge without a
  // timezone dependency. Quota resets are minute-granular, never ambiguous
  // sub-second instants.
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

/** Parse Claude's local-time reset fragment to an absolute instant. */
export function parseClaudeLimitResetAt(text, observedAtMs) {
  const match = CLAUDE_LIMIT_TEXT.exec(String(text || "").trim());
  if (!match?.[2]) return null;
  const reset = /^(\d{1,2}):(\d{2})(am|pm)(?:\s*\(([^)]+)\))?$/iu.exec(match[2].trim());
  if (!reset) return null;

  const timeZone = reset[4]
    || Intl.DateTimeFormat().resolvedOptions().timeZone
    || "UTC";
  let hour = Number(reset[1]) % 12;
  if (reset[3].toLowerCase() === "pm") hour += 12;
  const minute = Number(reset[2]);
  if (!Number.isFinite(observedAtMs) || minute > 59) return null;

  let dateParts;
  try {
    const observed = zonedParts(observedAtMs, timeZone);
    dateParts = {
      year: Number(observed.year),
      month: Number(observed.month),
      day: Number(observed.day),
      hour,
      minute,
    };
  } catch {
    return null;
  }

  let candidate;
  try { candidate = zonedEpoch(dateParts, timeZone); }
  catch { return null; }
  // A displayed reset earlier than the observed banner belongs to tomorrow.
  // Give equal-minute clocks a small tolerance for seconds between render and
  // JSONL persistence.
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
 * Pure receipt extractor. Returns null unless the newest quota banner has not
 * been superseded by a later user/assistant event.
 */
export function activeClaudeLimitReceiptFromEvents(events, {
  sessionId,
  sessionPath = null,
} = {}) {
  if (!sessionId || !Array.isArray(events)) return null;
  let found = null;
  for (let index = events.length - 1; index >= 0; index--) {
    const text = assistantText(events[index]);
    const match = text && CLAUDE_LIMIT_TEXT.exec(text);
    if (!match) continue;
    const event = events[index];
    if (!event.uuid || !event.timestamp) return null;
    const observedAt = Date.parse(event.timestamp);
    if (!Number.isFinite(observedAt)) return null;
    found = { index, event, text, match, observedAt };
    break;
  }
  if (!found) return null;
  if (events.slice(found.index + 1).some(isActionableAfterLimit)) return null;

  return Object.freeze({
    engine: "claude",
    sessionId,
    sessionPath,
    limitEventId: found.event.uuid,
    limitKind: found.match[1].toLowerCase(),
    text: found.text,
    observedAt: found.observedAt,
    resetAt: parseClaudeLimitResetAt(found.text, found.observedAt),
  });
}

/** Exact active quota receipt for one configured Claude pane cwd. */
export function activeClaudeLimitReceipt(paneDir, {
  homeDir = process.env.HOME,
  tailBytes = DEFAULT_LIMIT_TAIL_BYTES,
} = {}) {
  const identity = latestClaudeSessionIdentity(paneDir, { homeDir });
  if (!identity) return null;
  const events = parseJsonlWindow(identity.path, {
    initialBytes: Math.min(256 * 1024, tailBytes),
    maxBytes: tailBytes,
    enough: (rows) => rows.some((event) => CLAUDE_LIMIT_TEXT.test(assistantText(event) || "")),
  });
  return activeClaudeLimitReceiptFromEvents(events, {
    sessionId: identity.sessionId,
    sessionPath: identity.path,
  });
}

/** Decide whether a fresh quota snapshot (or exact reset clock) allows retry. */
export function claudeQuotaRecoveryReadiness(receipt, quota, {
  now = Date.now(),
  resetGraceMs = 15_000,
} = {}) {
  if (!receipt) return { ready: false, reason: "no-active-limit-receipt" };
  if (quota?.ok && Array.isArray(quota.limits)) {
    if (receipt.limitKind === "session") {
      const session = quota.limits.find((limit) => limit?.kind === "session");
      if (session && Number.isFinite(session.usedPercent)) {
        return Number(session.usedPercent) < 100
          ? { ready: true, via: "quota-api", usedPercent: Number(session.usedPercent) }
          : { ready: false, reason: "session-limit-still-exhausted" };
      }
    } else {
      const active = quota.limits.filter((limit) => limit?.isActive === true
        || limit?.kind === "session" || limit?.kind === "weekly_all");
      if (active.length && active.every((limit) => Number(limit.usedPercent) < 100)) {
        return { ready: true, via: "quota-api" };
      }
    }
  }
  if (Number.isFinite(receipt.resetAt) && now >= receipt.resetAt + resetGraceMs) {
    return { ready: true, via: "reset-clock" };
  }
  return { ready: false, reason: quota?.error || "quota-not-yet-available" };
}

export function quotaRecoveryJobKey(agentName, pane, receipt) {
  return `claude-quota-recovery:${agentName}:${Number(pane) || 0}:${receipt.sessionId}:${receipt.limitEventId}`;
}

export function quotaRecoveryContinuation() {
  return "[AMUX AUTOMATIC QUOTA RECOVERY · SAME CLAUDE SESSION]\n" +
    "Quota is available again. Continue the interrupted turn from the exact checkpoint immediately before the limit banner. " +
    "Re-read this session history and do not repeat an external side effect that already has a receipt. " +
    "If an in-flight tool result is ambiguous, verify its outcome before retrying. Finish the same task and report normally.";
}
