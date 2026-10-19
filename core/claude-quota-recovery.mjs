// Evidence reads and readiness rules for Claude subscription-limit recovery.

import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import { parseJsonlWindow } from "./jsonl-reader.mjs";
import { activeClaudeLimitReceiptFromEvents, claudeLimitFromText, claudeLimitEventText } from "./claude-limit-evidence.mjs";
export { activeClaudeLimitReceiptFromEvents, claudeLimitFromText, parseClaudeLimitResetAt, CLAUDE_STOP_BANNER } from "./claude-limit-evidence.mjs";

const DEFAULT_LIMIT_TAIL_BYTES = 8 * 1024 * 1024;

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
    enough: (rows) => rows.some((event) => claudeLimitFromText(claudeLimitEventText(event)) !== null),
  });
  return activeClaudeLimitReceiptFromEvents(events, {
    sessionId: identity.sessionId,
    sessionPath: identity.path,
  });
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
