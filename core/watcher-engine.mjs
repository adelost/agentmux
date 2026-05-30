// WHAT: Pure decision engine for mirroring one pane's completed jsonl turns.
// WHY: Keep checkpoint, partial-post, grace, backlog, and retry policy unit-testable
//      without Discord, tmux, fs.watch, timers, YAML, or process state.
// DOES NOT: Read files, post messages, capture tmux, parse config, schedule work,
//           or mutate the persistent state store directly.

const DEFAULT_COMPLETION_GRACE_MS = 5_000;
const DEFAULT_MAX_POST_ACTIONS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;
const DEFAULT_POSTED_COUNT_KEEP = 20;

export function planPaneMirrorStep(input = {}) {
  const {
    turns = [],
    lastPostedMs = null,
    postedItemCounts = {},
    nowMs = Date.now(),
    latestMtimeMs = null,
    retryUntilMs = null,
    completionGraceMs = DEFAULT_COMPLETION_GRACE_MS,
    maxPostActions = DEFAULT_MAX_POST_ACTIONS,
    postedCountKeep = DEFAULT_POSTED_COUNT_KEEP,
  } = input;

  const nextState = {
    lastPostedMs,
    postedItemCounts: trimPostedItemCounts({ ...postedItemCounts }, postedCountKeep),
    retryUntilMs,
  };
  const notes = [];

  if (retryUntilMs && retryUntilMs > nowMs) {
    return { actions: [], nextState, notes: [{ type: "retry-wait", untilMs: retryUntilMs }] };
  }

  if (!Array.isArray(turns) || turns.length === 0) {
    return { actions: [], nextState, notes };
  }

  if (lastPostedMs === null || lastPostedMs === undefined) {
    const newest = newestTurnMs(turns);
    if (Number.isFinite(newest)) {
      nextState.lastPostedMs = newest;
      nextState.retryUntilMs = null;
      notes.push({ type: "seed", lastPostedMs: newest });
    }
    return { actions: [], nextState, notes };
  }

  let cursorMs = Number.isFinite(lastPostedMs) ? lastPostedMs : 0;
  const actions = [];

  for (const turn of turns) {
    if (actions.length >= maxPostActions) break;

    const endMs = turnEndMs(turn);
    if (!Number.isFinite(endMs)) continue;
    if (endMs <= cursorMs) continue;

    const complete = classifyTurnCompleteness({ turn, nowMs, endMs, latestMtimeMs, completionGraceMs });
    if (!complete.done) continue;

    const turnStartMs = turnStartMsFor(turn, endMs);
    const items = Array.isArray(turn.items) ? turn.items : [];
    const postedCount = clampPostedCount(nextState.postedItemCounts[String(turnStartMs)], items.length);
    const newItems = items.slice(postedCount);

    if (newItems.length === 0) {
      cursorMs = endMs;
      nextState.lastPostedMs = cursorMs;
      nextState.retryUntilMs = null;
      notes.push({ type: "advance-empty", endMs, turnStartMs });
      continue;
    }

    actions.push({
      type: "postTurn",
      endMs,
      turnStartMs,
      postedCount,
      totalItems: items.length,
      reason: complete.reason,
      turn: { ...turn, items: newItems },
    });
  }

  return { actions, nextState, notes };
}

export function applyPostSuccess(state = {}, action, opts = {}) {
  const postedCountKeep = opts.postedCountKeep ?? DEFAULT_POSTED_COUNT_KEEP;
  const postedItemCounts = trimPostedItemCounts({
    ...(state.postedItemCounts || {}),
    [String(action.turnStartMs)]: action.totalItems,
  }, postedCountKeep);

  return {
    ...state,
    lastPostedMs: action.endMs,
    postedItemCounts,
    retryUntilMs: null,
  };
}

export function applyPostFailure(state = {}, action, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const retryBackoffMs = opts.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  return {
    ...state,
    retryUntilMs: nowMs + retryBackoffMs,
    lastFailedPost: {
      endMs: action?.endMs ?? null,
      turnStartMs: action?.turnStartMs ?? null,
      failedAtMs: nowMs,
    },
  };
}

export function newestTurnMs(turns = []) {
  for (let i = turns.length - 1; i >= 0; i--) {
    const ms = turnEndMs(turns[i]);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

export function turnEndMs(turn) {
  const iso = turn?.endTimestamp || turn?.timestamp;
  if (!iso) return NaN;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

export function turnStartMsFor(turn, fallbackMs) {
  if (turn?.timestamp) {
    const ms = new Date(turn.timestamp).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return fallbackMs;
}

function classifyTurnCompleteness({ turn, nowMs, endMs, latestMtimeMs, completionGraceMs }) {
  if (turn?.isComplete) return { done: true, reason: "stop_reason" };
  const oldEnough = nowMs - endMs >= completionGraceMs;
  const mtimeOldEnough = !latestMtimeMs || nowMs - latestMtimeMs >= completionGraceMs;
  if (oldEnough && mtimeOldEnough) return { done: true, reason: "grace" };
  return { done: false, reason: "incomplete" };
}

function clampPostedCount(v, totalItems) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(totalItems, Math.trunc(v)));
}

function trimPostedItemCounts(counts, keep) {
  const keys = Object.keys(counts)
    .map((k) => parseInt(k, 10))
    .filter((k) => Number.isFinite(k))
    .sort((a, b) => b - a);
  for (const old of keys.slice(keep)) delete counts[String(old)];
  return counts;
}
