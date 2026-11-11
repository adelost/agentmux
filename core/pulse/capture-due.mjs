// WHAT: Decides whether a watchdog needs a capture of a pane this round, from the pane's journal and hook activity.
// WHY: Keeps an idle pane from costing a tmux question every round (row 116c, DESIGN-pulse UC-1): a tool call and the prompt that follows it
// are written to the journal (or a Claude hook) first, so a pane whose activity has not changed has nothing new on its screen.

import { sessionReaderForCommand } from "../alternate-session-reader.mjs";
import { latestPaneStatesCached } from "../events.mjs";
import { panePathFor } from "../jsonl-reader.mjs";

/** WHAT: Names a pane's latest activity: its session journal's state and its last hook state. WHY: A change means a capture can matter. */
export function paneActivityStamp(agentConfig, paneIdx) {
  const journal = sessionReaderForCommand(agentConfig.panes?.[paneIdx]?.cmd || "").latestInfo(panePathFor(agentConfig, paneIdx));
  return JSON.stringify([journal, latestPaneStatesCached().get(`${agentConfig.name}:${paneIdx}`)?.ts ?? null]);
}

/**
 * WHAT: Builds a stamp of a pane's newest dialog hook: needsYou or a turn end.
 * WHY: Keeps journal writes and turn starts from costing a capture; prompts fire needsYou, offers follow turn ends.
 */
export function createDialogHookStamp({ states = latestPaneStatesCached } = {}) {
  const last = new Map();
  return function dialogHookStamp(agentConfig, paneIdx) {
    const paneKey = `${agentConfig.name}:${paneIdx}`;
    const pushed = states().get(paneKey);
    // A turn start replaces the pane's newest state, so the last dialog hook is remembered across it
    if (pushed && pushed.state !== "working") last.set(paneKey, pushed.ts);
    return last.get(paneKey) ?? null;
  };
}

/**
 * WHAT: Builds a per-watchdog check: due when the watchdog tracks the pane, when its activity changed within `activeMs`, on first sight,
 * or after `quietRecheckMs` without a capture (Infinity: never). WHY: One rule for every watchdog that captures panes.
 */
export function createCaptureDue({ activityOf = paneActivityStamp, activeMs = 60_000, quietRecheckMs = Infinity } = {}) {
  const activity = new Map();
  return function captureDue(agentConfig, paneIdx, at, { tracking = false } = {}) {
    const paneKey = `${agentConfig.name}:${paneIdx}`;
    const stamp = activityOf(agentConfig, paneIdx);
    const last = activity.get(paneKey);
    // First sight is captured once (!last) but is no change: counted as one, every pane was captured each round for its first minute
    // after a bridge start, 6 times, before its quiet recheck began (row 116c, 10 Nov)
    const changedAt = !last ? -Infinity : last.stamp !== stamp ? at : last.changedAt;
    const due = tracking || at - changedAt < activeMs || !last || at - last.capturedAt >= quietRecheckMs;
    activity.set(paneKey, { stamp, changedAt, capturedAt: due ? at : last.capturedAt });
    return due;
  };
}
