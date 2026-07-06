// WHAT: Pure decision engine for mirroring one pane's completed jsonl turns.
// WHY: Keep checkpoint, partial-post, grace, backlog, and retry policy unit-testable
//      without Discord, tmux, fs.watch, timers, YAML, or process state.
// DOES NOT: Read files, post messages, capture tmux, parse config, schedule work,
//           or mutate the persistent state store directly.

const DEFAULT_COMPLETION_GRACE_MS = 5_000;
const DEFAULT_MAX_POST_ACTIONS = 3;
const DEFAULT_RETRY_BACKOFF_MS = 30_000;
// Retain enough posted item-ids to cover every turn still inside the tail
// window (TURN_LOOKBACK turns, up to dozens of items each). An id that falls
// out of this set could be re-posted, so keep it comfortably above the worst
// case rather than tight.
const DEFAULT_POSTED_ID_KEEP = 1_000;
const DEFAULT_PARTIAL_TEXT_GRACE_MS = 60_000;

// Identity of a postable item for the posted-set dedupe. Readers stamp a stable
// content-addressed id (Claude uuid:block, codex sha1:block) that survives the
// sliding tail window. The positional fallback (turnStartMs#idx) exists ONLY for
// legacy/id-less items and is deliberately weak: it drifts as the window slides,
// which is the exact bug the id-based key fixes, so real items must carry an id.
export function itemKey(item, turnStartMs, idx) {
  if (item && typeof item.id === "string" && item.id) return item.id;
  return `${turnStartMs}#${idx}`;
}

export function planPaneMirrorStep(input = {}) {
  const {
    turns = [],
    lastPostedMs = null,
    postedItemIds = [],
    truncated = false,
    nowMs = Date.now(),
    latestMtimeMs = null,
    retryUntilMs = null,
    completionGraceMs = DEFAULT_COMPLETION_GRACE_MS,
    partialTextGraceMs = DEFAULT_PARTIAL_TEXT_GRACE_MS,
    maxPostActions = DEFAULT_MAX_POST_ACTIONS,
    postedIdKeep = DEFAULT_POSTED_ID_KEEP,
  } = input;

  const postedSet = new Set(Array.isArray(postedItemIds) ? postedItemIds : []);
  const nextState = {
    lastPostedMs,
    postedItemIds: trimIds(Array.isArray(postedItemIds) ? [...postedItemIds] : [], postedIdKeep),
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

  turns.forEach((turn, index) => {
    if (actions.length >= maxPostActions) return;

    const endMs = turnEndMs(turn);
    if (!Number.isFinite(endMs)) return;
    if (endMs <= cursorMs) return;

    const complete = classifyTurnCompleteness({ turn, nowMs, endMs, latestMtimeMs, completionGraceMs });
    if (!complete.done) return;

    const turnStartMs = turnStartMsFor(turn, endMs);
    const items = Array.isArray(turn.items) ? turn.items : [];
    const postableItemCount = postableCountForTurn({
      turn,
      items,
      complete,
      nowMs,
      endMs,
      partialTextGraceMs,
    });

    // Dedupe on stable ids, NOT on a count into a sliding array: post exactly
    // the postable items whose id we have not posted before.
    const newItems = [];
    const newIds = [];
    for (let idx = 0; idx < postableItemCount; idx++) {
      const it = items[idx];
      const key = itemKey(it, turnStartMs, idx);
      if (!postedSet.has(key)) { newItems.push(it); newIds.push(key); }
    }

    if (newItems.length === 0) {
      if (postableItemCount >= items.length) {
        // Safety net: when the read is truncated the leading (oldest, index 0)
        // turn may be missing its head, so "no new items" can mean "the item is
        // out of the window", not "already posted". Do NOT advance past it; hold
        // and re-check next poll. Later whole turns still advance the cursor.
        if (truncated && index === 0) {
          notes.push({ type: "hold-truncated", endMs, turnStartMs });
        } else {
          cursorMs = endMs;
          nextState.lastPostedMs = cursorMs;
          nextState.retryUntilMs = null;
          notes.push({ type: "advance-empty", endMs, turnStartMs });
        }
      } else {
        notes.push({ type: "hold-growing-tail", endMs, turnStartMs, postableItemCount, totalItems: items.length });
      }
      return;
    }

    actions.push({
      type: "postTurn",
      endMs,
      turnStartMs,
      postedIds: newIds,
      postedCount: postableItemCount - newItems.length,
      totalItems: postableItemCount,
      reason: complete.reason,
      turn: { ...turn, items: newItems },
    });
  });

  return { actions, nextState, notes };
}

export function applyPostSuccess(state = {}, action, opts = {}) {
  const postedIdKeep = opts.postedIdKeep ?? DEFAULT_POSTED_ID_KEEP;
  const prior = Array.isArray(state.postedItemIds) ? state.postedItemIds : [];
  const postedItemIds = trimIds([...prior, ...(action?.postedIds || [])], postedIdKeep);

  return {
    ...state,
    lastPostedMs: action.endMs,
    postedItemIds,
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

function postableCountForTurn({ turn, items, complete, nowMs, endMs, partialTextGraceMs }) {
  if (!Array.isArray(items) || items.length === 0) return 0;
  if (turn?.isComplete || complete.reason !== "grace") return items.length;

  const last = items[items.length - 1];
  const trailingTextMayStillGrow = last?.type !== "tool";
  if (!trailingTextMayStillGrow) return items.length;

  const staleMs = nowMs - endMs;
  if (Number.isFinite(staleMs) && staleMs >= partialTextGraceMs) return items.length;

  return Math.max(0, items.length - 1);
}

// Keep the newest `keep` unique ids, preserving order. De-dupes so a repeated
// id (re-seen across polls before it was trimmed) does not consume two slots.
function trimIds(ids, keep) {
  const seen = new Set();
  const out = [];
  for (let i = ids.length - 1; i >= 0 && out.length < keep; i--) {
    const id = ids[i];
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.reverse();
}
