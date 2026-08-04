// Periodic incident reminder on board use (Mattias 2026-08-04).
//
// The 2026-08-04 incident: agents drifted into repairing board machinery
// instead of shipping the user's priorities, and the prose rule against it
// was forgotten after /compact. Mattias's direction: the reminder must be
// actively DELIVERED to the agent where the drift happens — at the board —
// not sit in a file nobody re-reads. amux-suggest is the sanctioned board
// mutation path, so every Nth use (or after a quiet gap) it emits the
// canonical reminder text on stderr, where the invoking agent reads it in
// the tool result without corrupting the stdout API response.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const BOARD_REMINDER_TEXT_PATH =
  join(homedir(), ".agentmux", "board-incident-reminder.md");
export const BOARD_REMINDER_STATE_PATH =
  join(homedir(), ".agentmux", "board-use-reminder-state.json");

/** Every Nth board use triggers the reminder even inside a busy hour. */
const EVERY_N_USES = 5;
/** A quiet gap this long makes the very next board use remind. */
const MAX_SILENT_MS = 2 * 60 * 60 * 1000;

/**
 * Pure cadence decision: given the persisted state and the clock, should
 * THIS board use carry the reminder? First use ever reminds (lastShownAt 0
 * is always past the silent gap), then every Nth use or after a quiet gap.
 */
export function decideBoardReminder(state, nowMs) {
  const usesSinceShown = (Number(state?.usesSinceShown) || 0) + 1;
  const lastShownAt = Number(state?.lastShownAt) || 0;
  const show = usesSinceShown >= EVERY_N_USES || nowMs - lastShownAt >= MAX_SILENT_MS;
  return show
    ? { show, nextState: { usesSinceShown: 0, lastShownAt: nowMs } }
    : { show, nextState: { usesSinceShown, lastShownAt } };
}

const loadState = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
};

const saveState = (state, path) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state) + "\n");
};

/**
 * Emit the reminder to stderr when due. Never throws and never blocks the
 * board call itself: a broken reminder must not become one more reason to
 * repair machinery instead of shipping.
 */
export function emitBoardUseReminder({
  nowMs = Date.now(),
  textPath = BOARD_REMINDER_TEXT_PATH,
  statePath = BOARD_REMINDER_STATE_PATH,
  write = (text) => process.stderr.write(text),
} = {}) {
  try {
    const { show, nextState } = decideBoardReminder(loadState(statePath), nowMs);
    saveState(nextState, statePath);
    if (!show) return false;
    write(readFileSync(textPath, "utf8"));
    return true;
  } catch {
    return false;
  }
}
