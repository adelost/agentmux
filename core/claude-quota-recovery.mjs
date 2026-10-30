// Evidence reads and readiness rules for Claude subscription-limit recovery.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import { parseJsonlText, parseJsonlWindow } from "./jsonl-reader.mjs";
import { createStampMemo } from "./stamp-memo.mjs";
import { activeClaudeLimitReceiptFromEvents, claudeLimitFromText, claudeLimitEventText, claudeLimitNote } from "./claude-limit-evidence.mjs";
export { activeClaudeLimitReceiptFromEvents, claudeLimitFromText, parseClaudeLimitResetAt, CLAUDE_STOP_BANNER } from "./claude-limit-evidence.mjs";

const DEFAULT_LIMIT_TAIL_BYTES = 8 * 1024 * 1024;
// A pane without a limit note read the whole 8 MB window on every quota tick.
const receiptsByJournal = createStampMemo();
// A busy journal changes every tick, so the stamp alone still read 16 MB per tick and journal
// (30 Oct: 109 to 261 MB per 10 s, delivery stalled). A window without limit evidence stays so
// while the lines appended after it hold none either.
const limitFreeJournals = new Map(); // key → { ino, readTo: byte after the last complete line read }
const MAX_LIMIT_FREE_JOURNALS = 256;
const LINE_END_SEARCH_BYTES = 64 * 1024;
const statOrNull = (path) => { try { return statSync(path); } catch { return null; } };
const hasLimitEvidence = (event) => claudeLimitFromText(claudeLimitEventText(event)) !== null || claudeLimitNote(event) !== null;

function readBytes(path, start, length) {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    return buffer.subarray(0, readSync(fd, buffer, 0, length, start));
  } finally { closeSync(fd); }
}

/** WHAT: Finds the byte after the last newline at or before size, or null. WHY: A line still being written is read again in full. */
function lineEndAtOrBefore(path, size) {
  const start = Math.max(0, size - LINE_END_SEARCH_BYTES);
  const newline = readBytes(path, start, size - start).lastIndexOf(0x0a);
  return newline === -1 ? (start === 0 ? 0 : null) : start + newline + 1;
}

/** WHAT: Reads only the lines appended since a limit-free read. WHY: Keeps a busy journal from being read whole on every tick. */
function appendedLinesHoldNoLimit(path, limitFree, stat, tailBytes) {
  if (!limitFree || !stat || stat.ino !== limitFree.ino || stat.size < limitFree.readTo
    || stat.size - limitFree.readTo > tailBytes) return false;
  const appended = readBytes(path, limitFree.readTo, stat.size - limitFree.readTo);
  // A line still being written stays after readTo and is read whole next time.
  const complete = appended.subarray(0, appended.lastIndexOf(0x0a) + 1);
  if (parseJsonlText(complete.toString("utf8")).some(hasLimitEvidence)) return false;
  limitFree.readTo += complete.length;
  return true;
}

function rememberLimitFree(key, path, stat, events) {
  limitFreeJournals.delete(key);
  const readTo = stat && !events.some(hasLimitEvidence) ? lineEndAtOrBefore(path, stat.size) : null;
  if (readTo === null) return;
  limitFreeJournals.set(key, { ino: stat.ino, readTo });
  while (limitFreeJournals.size > MAX_LIMIT_FREE_JOURNALS) limitFreeJournals.delete(limitFreeJournals.keys().next().value);
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
  const key = `${identity.path}\0${tailBytes}`, stat = statOrNull(identity.path);
  const known = receiptsByJournal.get(key, stat);
  if (known !== undefined) return known;
  if (appendedLinesHoldNoLimit(identity.path, limitFreeJournals.get(key), stat, tailBytes)) return receiptsByJournal.set(key, stat, null);
  const events = parseJsonlWindow(identity.path, {
    initialBytes: Math.min(256 * 1024, tailBytes),
    maxBytes: tailBytes,
    enough: (rows) => rows.some(hasLimitEvidence),
  });
  rememberLimitFree(key, identity.path, stat, events);
  return receiptsByJournal.set(key, stat, activeClaudeLimitReceiptFromEvents(events, {
    sessionId: identity.sessionId,
    sessionPath: identity.path,
  }));
}

// Every plan window must have room, whichever one stopped the pane: a fresh
// session in a spent week would run on paid usage (15 Sep: €20 in 1 min 43 s).
const planWindows = (quota) => (quota?.ok && Array.isArray(quota.limits) ? quota.limits : [])
  .filter((limit) => (limit?.isActive === true || limit?.kind === "session" || limit?.kind === "weekly_all")
    && Number.isFinite(limit.usedPercent));

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
    const windows = planWindows(quota);
    const spent = windows.find((limit) => Number(limit.usedPercent) >= 100);
    if (spent) return { ready: false, reason: `${spent.kind === "session" ? "session" : "weekly"}-limit-still-exhausted` };
    const session = windows.find((limit) => limit.kind === "session");
    if (windows.length) {
      return receipt.limitKind === "session" && session
        ? { ready: true, via: "quota-api", usedPercent: Number(session.usedPercent) }
        : { ready: true, via: "quota-api" };
    }
  }
  if (Number.isFinite(receipt.resetAt) && now >= receipt.resetAt + resetGraceMs) {
    return { ready: true, via: "reset-clock" };
  }
  return { ready: false, reason: quota?.error || "quota-not-yet-available" };
}

/**
 * WHAT: Tells whether a parked pane's own account has spent its week, per a reading taken after the limit.
 * WHY: Only a reached weekly limit moves a pane to another account; a session window returns within hours.
 */
export const claudeWeekSpent = (readiness) => readiness?.reason === "weekly-limit-still-exhausted";

/**
 * WHAT: Returns an account's used weekly percent when every plan window has room, else null.
 * WHY: An account at its reserve level would stop a moved pane again within minutes, after a full cache miss.
 */
export function claudeWeeklyRoom(quota, { reservePercent = 90 } = {}) {
  const windows = planWindows(quota);
  if (windows.some((limit) => Number(limit.usedPercent) >= 100)) return null;
  const weekly = windows.find((limit) => limit.kind === "weekly_all");
  return weekly && Number(weekly.usedPercent) < reservePercent ? Number(weekly.usedPercent) : null;
}

/**
 * WHAT: Picks the logged-in Claude account with the most weekly room, other than the pane's own login.
 * WHY: A pane stopped at a spent week resumes where the paid subscription can still answer
 * (2026-10-18: six panes waited 5.8 h on Claude W while Claude S had 100 % free).
 */
export async function spareClaudeAccount({
  current,
  catalog,
  authenticated,
  readQuota,
  emailOf,
  reservePercent = 90,
}) {
  const ownEmail = current ? emailOf(current) : null;
  let best = null;
  for (const profile of catalog) {
    if (!profile || profile.key === current?.key || !authenticated(profile)) continue;
    // Another dir of the spent login is the same spent week.
    if (ownEmail && emailOf(profile) === ownEmail) continue;
    const quota = await readQuota(profile);
    const usedPercent = claudeWeeklyRoom(quota, { reservePercent });
    if (usedPercent !== null && (!best || usedPercent < best.usedPercent)) best = { profile, quota, usedPercent };
  }
  return best;
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
