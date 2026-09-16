// Chooses which of a pane's turns one Dream shows. On 2026-09-16 skyvw:0 had
// 103 work turns in a day, 70 of them background-task notifications, so
// neither "the newest eight" nor "the oldest first, the rest later" works:
// the first hides the morning's decisions, the second never catches up.

import { isDreamActivityTurn, validDreamCursor } from "./dream-eligibility.mjs";

/** WHAT: Defines how far back a stale receipt may reach. WHY: Keeps a missed night's work eligible without replaying a pane's whole history. */
export const DREAM_CATCH_UP_MS = 7 * 24 * 60 * 60 * 1000;
/** WHAT: Defines how recently a journal must change for its open turn to count as running. WHY: Keeps a turn's missing outcome from being receipted. */
export const DREAM_SETTLE_MS = 10 * 60 * 1000;

/** WHAT: Names prompts a machine wrote rather than a person. WHY: Keeps relays and notifications from outranking a human decision. */
const MACHINE_PROMPT = /^\s*(?:\[from [\w-]+:\d+\]|<task-notification>|\[(?:krasch|stop-all)-recovery\]|\[amux\b)/iu;
/** WHAT: Names a turn's final report. WHY: Keeps a released result from losing its place to intermediate chatter. */
const REPORT_LINE = /^\s*(?:SUMMARY|DONE|BLOCKED)\s*:/mu;

const timeMs = (turn) => Date.parse(turn?.timestamp || "");
const finalText = (turn) => (turn.items || []).filter((item) => item.type === "text").at(-1)?.content || "";

function turnWeight(turn) {
  if (!MACHINE_PROMPT.test(String(turn.userPrompt || ""))) return 2;
  return REPORT_LINE.test(finalText(turn)) ? 1 : 0;
}

function isStillRunning(turn, lastWriteMs, nowMs) {
  return turn.isComplete !== true && Number.isFinite(lastWriteMs) && nowMs - lastWriteMs < DREAM_SETTLE_MS;
}

/** WHAT: Resolves where a pane's Dream window starts. WHY: Keeps a failed night's work from falling behind the next night's 24 hours. */
export function dreamWindowStartMs(receipt, sinceMs) {
  if (!validDreamCursor(receipt?.activityCursor)) return sinceMs;
  return Math.max(Date.parse(receipt.activityCursor), sinceMs - DREAM_CATCH_UP_MS);
}

/**
 * WHAT: Filters a pane's settled work turns down to the ones a digest needs.
 * WHY: Keeps human decisions and final reports in a bounded input, and a running turn out of the receipt.
 */
export function selectDreamTurns(turns, { cursorMs, limit, lastWriteMs = null, nowMs = Date.now() }) {
  const eligible = turns.filter((turn) => timeMs(turn) > cursorMs && isDreamActivityTurn(turn.userPrompt))
    .sort((left, right) => timeMs(left) - timeMs(right));
  const running = eligible.length > 0 && isStillRunning(eligible.at(-1), lastWriteMs, nowMs);
  const settled = running ? eligible.slice(0, -1) : eligible;
  const shown = new Set([...settled].sort((left, right) => turnWeight(right) - turnWeight(left)
    || timeMs(right) - timeMs(left)).slice(0, limit));
  return {
    entries: settled.filter((turn) => shown.has(turn)),
    omittedTurns: settled.length - shown.size,
    deferredTurns: running ? 1 : 0,
    activityCursor: settled.at(-1)?.timestamp ?? null,
  };
}
