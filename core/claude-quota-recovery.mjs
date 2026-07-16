// Pure evidence and readiness rules for Claude subscription-limit recovery.

import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import { parseJsonlWindow } from "./jsonl-reader.mjs";

/** DTO: Exact terminal quota response accepted as restart evidence. */
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

/**
 * WHAT: Reads the active limit receipt for one pane cwd from bounded JSONL history.
 * WHY: Keeps restart identity bound to the newest persisted Claude session.
 */
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

/**
 * WHAT: Checks whether fresh quota telemetry or the exact reset permits recovery.
 * WHY: Prevents automatic restart while Claude still reports exhausted capacity.
 */
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

/** WHAT: Builds one stable recovery job identity. WHY: Prevents duplicate continuation turns across polls. */
export function quotaRecoveryJobKey(agentName, pane, receipt) {
  return `claude-quota-recovery:${agentName}:${Number(pane) || 0}:${receipt.sessionId}:${receipt.limitEventId}`;
}

/** WHAT: Formats the same-session continuation instruction. WHY: Avoids replaying the original task from its beginning. */
export function quotaRecoveryContinuation() {
  return "[AMUX AUTOMATIC QUOTA RECOVERY · SAME CLAUDE SESSION]\n" +
    "Quota is available again. Continue the interrupted turn from the exact checkpoint immediately before the limit banner. " +
    "Re-read this session history and do not repeat an external side effect that already has a receipt. " +
    "If an in-flight tool result is ambiguous, verify its outcome before retrying. Finish the same task and report normally.";
}
