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

/** WHAT: Parses drift-guard environment settings. WHY: Keeps configuration separate from reminder decisions. */
export function parseReminderConfig(env = process.env) {
  const isDisabled = env.AMUX_REMIND_ENABLED === "false";
  const threshold = parseInt(env.AMUX_REMIND_TURN_THRESHOLD || "40", 10);
  const pollMs = parseInt(env.AMUX_REMIND_POLL_MS || "60000", 10);
  const activeWindowMs = parseInt(env.AMUX_REMIND_ACTIVE_WINDOW_MS || "3600000", 10);
  return {
    enabled: !isDisabled,
    turnThreshold: Number.isFinite(threshold) && threshold > 0 ? threshold : 40,
    pollMs: Number.isFinite(pollMs) && pollMs >= 10_000 ? pollMs : 60_000,
    activeWindowMs: Number.isFinite(activeWindowMs) && activeWindowMs >= 60_000
      ? activeWindowMs : 3_600_000,
    statePath: env.AMUX_REMINDER_STATE_PATH || REMINDER_STATE_PATH,
  };
}

/** WHAT: Checks whether a reminder target is live and recently used. WHY: Prevents maintenance from waking sleeping or abandoned panes. */
export function isReminderTargetActive({ latestWorkTsMs, nowMs, activeWindowMs, runtimeState }) {
  if (!runtimeState || runtimeState.dead || runtimeState.shell || runtimeState.running !== true) {
    return { active: false, reason: "pane is sleeping or unavailable" };
  }
  if (!Number.isFinite(latestWorkTsMs) || !Number.isFinite(nowMs)
      || !Number.isFinite(activeWindowMs) || activeWindowMs < 0) {
    return { active: false, reason: "no recent work activity" };
  }
  const ageMs = nowMs - latestWorkTsMs;
  if (ageMs < 0 || ageMs > activeWindowMs) {
    return { active: false, reason: "work activity is stale" };
  }
  return { active: true, reason: "pane is live with recent work" };
}

/** WHAT: Returns reminder eligibility. WHY: Keeps delivery effects separate from eligibility. */
export function decideReminderAction({
  turnsSinceCutoff, status, turnThreshold,
  latestWorkTsMs, nowMs, activeWindowMs, runtimeState,
}) {
  if (!Number.isFinite(turnsSinceCutoff) || turnsSinceCutoff < 0) {
    return { action: "none", reason: "invalid turn count" };
  }
  if (status === "working" || status === "permission" || status === "menu" || status === "resume") {
    return { action: "none", reason: `pane is ${status}` };
  }
  if (status === "unknown") {
    return { action: "none", reason: "unknown status (conservative)" };
  }
  const activity = isReminderTargetActive({ latestWorkTsMs, nowMs, activeWindowMs, runtimeState });
  if (!activity.active) return { action: "none", reason: activity.reason };
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

/** Advance rotation only after the pane accepted the reminder. */
export function recordReminderDelivery(paneState, { delivered, nowMs, reminderCount }) {
  if (!delivered) return false;
  paneState.lastReminderTsMs = nowMs;
  paneState.reminderCount = reminderCount + 1;
  return true;
}

/**
 * Drift-prone rules the reminder rotates over. Order matters: fresh panes
 * and state resets start at index 0, so the first nudge always lands on
 * the highest-priority rule. To weight a rule heavier, list it more than
 * once — the list is the mechanism.
 *
 * `directive` must be self-contained: it travels inside the message, so
 * the core of the rule reaches the pane even if a heading is later
 * renamed. `section: null` means "re-read the whole file". CLAUDE.md
 * section names must match the AGENT_HINTS headings in agent.mjs.
 *
 * Code standards also have event hooks (post-compact re-anchor,
 * first-edit-per-session) that fire at the sharp moments; the rotation
 * entry covers slow decay BETWEEN those moments in long coding sessions.
 */
export const DRIFT_SECTIONS = [
  {
    file: ".agents/CLAUDE.md",
    section: "Kommunikationsdisciplin",
    label: "kommunikationsdisciplin (prata bara vid klart/beslut/blocker)",
    directive: "message other panes only when a major task is DONE, " +
      "you genuinely need a decision, or something blocks the recipient. " +
      "No status pings, no acks, no politeness; commits + ledger ARE the status.",
  },
  {
    file: "~/.claude/coding-philosophy.md",
    section: null,
    label: "coding-philosophy.md (deklarativt, Result<T,E>, bdd-vitest, inga tysta fallbacks)",
    directive: "declarative + data-driven, Result<T,E> for domain errors, " +
      "bdd-vitest for every change, max ~500 lines/file, no silent fallbacks. " +
      "Run tests + lint before claiming done.",
  },
  {
    file: ".agents/CLAUDE.md",
    section: "Always lead with a recommendation",
    label: "lead with a recommendation (aldrig 'up to you')",
    directive: "when presenting options, lead with one concrete pick plus " +
      "a one-line why tied to the user's goals. Never 'up to you'.",
  },
  {
    file: ".agents/CLAUDE.md",
    section: "Root cause > symptoms",
    label: "root cause > symptoms (aldrig --no-verify)",
    directive: "fix the cause, not the symptom. " +
      "No --no-verify, no swallowed errors, no skipped tests.",
  },
];

/**
 * The reminder text sent to the pane. Short by design — long reminders
 * get ignored. Refers to the .agents/CLAUDE.md file because that's where
 * the rules live and are always system-context-loaded.
 *
 * Behavior change in 1.16.10: previously asked the agent to "absorb
 * silently" (588d421 in 1.12.x). That kept the channel quiet but the
 * rule never re-entered active context — agents drifted right back into
 * the same anti-pattern within 1-2 turns. The new prompt requires a
 * one-sentence summary so the rule lands as the latest assistant text;
 * the next turn now has the directive hot in working memory instead of
 * fading into system-context.
 *
 * Behavior change in 1.20.69: the highlighted section rotates through
 * DRIFT_SECTIONS keyed on the pane's reminderCount, instead of always
 * naming one hardcoded rule. Each message stays one-rule short (that's
 * why reminders land at all) while every drift-prone rule gets its turn.
 *
 * Behavior change in 1.20.90 (Mattias 2026-07-11): mention-all,
 * deep-dive-one. Rotation alone left a rule unmentioned for
 * 40×N turns; now every reminder lists ALL drift-prone rules as
 * one-liners while the rotating rule keeps the re-read + the
 * one-sentence summary (the salience mechanism). A four-sentence
 * recital would go boilerplate the same way "absorb silently" did,
 * so the summary demand stays single-rule.
 *
 * @param {number} turnCount - user turns since the pane's last refresh
 * @param {number} reminderCount - reminders already sent to this pane
 */
export function formatReminderMessage(turnCount, reminderCount = 0) {
  const idx = reminderCount % DRIFT_SECTIONS.length;
  const rule = DRIFT_SECTIONS[idx];
  const where = rule.section
    ? `the "${rule.section}" section of ${rule.file}`
    : rule.file;
  const others = DRIFT_SECTIONS
    .filter((_, i) => i !== idx)
    .map((r) => r.label)
    .join("; ");
  return `[drift-guard] Re-read ${where}: ${rule.directive} ` +
    `Also still in force: ${others}. ` +
    `You are ${turnCount}+ turns past your last refresh; attention weights decay. ` +
    `Reply with ONE sentence summarizing the highlighted rule's core directive, then ` +
    `continue your current task. The summary keeps the rule hot in context ` +
    `for the next turns; that's the point, not boilerplate ack.`;
}
