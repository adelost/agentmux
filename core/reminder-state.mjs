// Drift-guard state persistence + pure decision logic.
//
// Long-running Claude panes drift from their CLAUDE.md rules as the
// conversation accumulates turns — attention weights favor recent content,
// so rules stated "long ago" (pre-compact system-context is always present,
// but its effective weight tunnas). /compact resets this because context
// shrinks and rules are re-loaded with fresh prominence.
//
// This module decides WHEN to send a short "re-read your CLAUDE.md"
// reminder to a pane. Strategy: count turns since the later of
// (a) last reminder, (b) last /compact on this pane. If that exceeds a
// threshold AND the pane is idle, it's time.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export const REMINDER_STATE_PATH =
  process.env.AMUX_REMINDER_STATE_PATH ||
  "/tmp/agentmux-reminder-state.json";

/**
 * Load per-pane state map. Returns empty object when file missing or
 * malformed — caller can always call decideReminderAction and the state
 * will rebuild as events land.
 */
export function loadReminderState(path = REMINDER_STATE_PATH) {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === "object") ? parsed : {};
  } catch {
    return {};
  }
}

export function saveReminderState(state, path = REMINDER_STATE_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}

/**
 * Parse drift-guard config from env with sensible defaults. Kept pure
 * (takes env as arg) so tests can inject.
 *
 * @param {Record<string,string>} env - process.env or a fake
 */
export function parseReminderConfig(env = process.env) {
  const isDisabled = env.AMUX_REMIND_ENABLED === "false";
  const threshold = parseInt(env.AMUX_REMIND_TURN_THRESHOLD || "40", 10);
  const pollMs = parseInt(env.AMUX_REMIND_POLL_MS || "60000", 10);
  return {
    enabled: !isDisabled,
    turnThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 40,
    pollMs: Number.isFinite(pollMs) && pollMs >= 10_000 ? pollMs : 60_000,
    statePath: env.AMUX_REMINDER_STATE_PATH || REMINDER_STATE_PATH,
  };
}

/**
 * Decide whether to send a reminder to a pane right now.
 *
 * The caller is responsible for state UPDATE — this function only returns
 * an action. That keeps the decision pure and testable without filesystem.
 *
 * Inputs:
 *  - turnsSinceCutoff: user-turn count since max(lastReminderTs, lastCompactTs)
 *  - status: live pane status ("working"|"idle"|"permission"|"menu"|"unknown")
 *
 * Actions:
 *  - "send"  → fire reminder, caller updates state.lastReminderTs to now
 *  - "none"  → nothing needed
 *
 * Rules:
 *  - Never interrupt working/permission/menu — wait for idle
 *  - threshold crossed → send
 *  - unknown status → conservative, treat as working (no send)
 */
export function decideReminderAction({ turnsSinceCutoff, status, turnThreshold }) {
  if (!Number.isFinite(turnsSinceCutoff) || turnsSinceCutoff < 0) {
    return { action: "none", reason: "invalid turn count" };
  }
  if (status === "working" || status === "permission" || status === "menu" || status === "resume") {
    return { action: "none", reason: `pane is ${status}` };
  }
  if (status === "unknown") {
    return { action: "none", reason: "unknown status (conservative)" };
  }
  if (turnsSinceCutoff < turnThreshold) {
    return { action: "none", reason: `${turnsSinceCutoff} < ${turnThreshold}` };
  }
  return { action: "send", reason: `${turnsSinceCutoff} >= ${turnThreshold}` };
}

/**
 * Compute the effective cutoff for "turns since last refresh" = the LATER
 * of lastReminderTs and lastCompactTs. Either may be null. Returns null
 * when both are null (meaning: count from the beginning, which caps at 51
 * inside countTurnsSince).
 *
 * @returns {number|null} epoch ms, or null
 */
export function cutoffFor(paneState) {
  if (!paneState) return null;
  const rem = Number.isFinite(paneState.lastReminderTsMs) ? paneState.lastReminderTsMs : null;
  const comp = Number.isFinite(paneState.lastCompactTsMs) ? paneState.lastCompactTsMs : null;
  if (rem == null) return comp;
  if (comp == null) return rem;
  return rem > comp ? rem : comp;
}

/**
 * The reminder text sent to the pane. Short by design — long reminders
 * get ignored. Refers to the .agents/CLAUDE.md file because that's where
 * the rule lives and is always system-context-loaded.
 */
export function formatReminderMessage(turnCount) {
  return `[drift-guard] Silently re-read .agents/CLAUDE.md — especially the ` +
    `"Always lead with a recommendation" section. You are ${turnCount}+ turns past ` +
    `your last refresh; attention weights decay. ` +
    `No reply needed — absorb and continue with your current task.`;
}
