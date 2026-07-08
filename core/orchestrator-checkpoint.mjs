// Orchestrator-facing pure primitives for `amux done`.
//
// The "checkpoint / since-last-check" mechanism that used to live here was
// removed in 1.16.19 — agents read full output deterministically and humans
// glance at the recent-activity feed, so neither audience used a stateful
// inbox. `amux done` is now pure time-window + idempotent.
//
// What remains: bucket-and-classify helpers used by cmdDone to render rows.

import { isLiveStatus, needsHumanStatus } from "./pane-status.mjs";

/**
 * Bucket timeline rows by `agent:pane` key. Each bucket captures the turn
 * count since cutoff plus the latest user prompt and assistant response
 * (text-only; tool-call rows are ignored for the "preview" slots because
 * they're noise, though they still count toward turns).
 */
export function groupByPane(rows) {
  const buckets = new Map();
  for (const r of rows) {
    const key = `${r.agent}:${r.pane}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        agent: r.agent,
        pane: r.pane,
        turns: 0,
        latestTurnTs: null,
        lastUserText: null,
        lastUserTextTs: null,
        // Ring of the most-recent user directives (oldest→newest, cap 3).
        // Agents reading `amux done` use this to see what a pane was told
        // to do, not just where it landed — the coordination context that
        // a single last-line preview can't carry. lastUserText stays as the
        // single-latest alias for back-compat with isStaleWaiter/classify.
        recentUserTexts: [],
        lastAssistantText: null,
        lastAssistantTextTs: null,
      });
    }
    const b = buckets.get(key);
    b.turns++;
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN;
    const tValid = Number.isFinite(t);
    if (tValid && (b.latestTurnTs == null || t > b.latestTurnTs)) {
      b.latestTurnTs = t;
    }
    if (r.type === "text" || r.type == null) {
      if (r.role === "user" && r.content) {
        b.lastUserText = r.content;
        if (tValid) b.lastUserTextTs = t;
        b.recentUserTexts.push(r.content);
        if (b.recentUserTexts.length > 3) b.recentUserTexts.shift();
      }
      if (r.role === "assistant" && r.content) {
        b.lastAssistantText = r.content;
        if (tValid) b.lastAssistantTextTs = t;
      }
    }
  }
  return buckets;
}

/**
 * A waiter is "stale" when the assistant last produced text BEFORE the
 * orchestrator's last checkpoint. That means the ask existed in the
 * previous check-in too — it shouldn't show up as new actionable work.
 * Missing timestamp → treat as stale (no evidence it's fresh).
 */
export function isStaleWaiter(bucket, sinceMs) {
  if (!bucket || !Number.isFinite(sinceMs)) return false;
  const ts = bucket.lastAssistantTextTs;
  if (!Number.isFinite(ts)) return true;
  return ts < sinceMs;
}

/**
 * Live-running detection: the pane's most recent jsonl event happened
 * within `withinMs` of now. jsonl is written as events stream, so a
 * <60s-old event means something is actively producing output. This is
 * strictly stronger than tmux-pane-status which can report "working"
 * minutes after the agent stopped.
 *
 * 60s default chosen so deep-thinking pauses (Claude can pause 30-50s
 * between tool calls during hard reasoning) don't flicker to 💤. Same
 * window as `amux ps`'s jsonl-mtime overlay (cmdPs.inspectPane) for
 * cross-command consistency.
 */
export function isRunningNow(bucket, nowMs, withinMs = 60_000) {
  if (!bucket || !Number.isFinite(nowMs)) return false;
  const ts = bucket.latestTurnTs;
  if (!Number.isFinite(ts)) return false;
  return nowMs - ts <= withinMs;
}

/**
 * Heuristic: does this assistant message read like it's waiting on user
 * input? Matches explicit question marks + common Swedish/English prompts
 * ("säg", "bekräfta", "vill du", "want me to", etc). Kept conservative —
 * false-positives just show "waiting" instead of "finished" which is
 * annoying but not dangerous; false-negatives miss a wait signal which
 * matters more for orchestration correctness.
 */
export function isWaitingLikeText(text) {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;

  // Last ~300 chars is where the ask usually lives (previous context is noise).
  const tail = trimmed.slice(-300).toLowerCase();

  if (/\?\s*$/.test(trimmed)) return true;

  const cues = [
    /\bsäg\b.*(skippa|fixa|bekräfta|ja|nej)/,
    /bekräfta\b/,
    /vill du /,
    /ska jag /,
    /want me to /,
    /should i /,
    /let me know /,
    /awaiting /,
    /avvaktar\b/,
    /väntar på /,
    /confirm\b/,
  ];
  return cues.some((r) => r.test(tail));
}

/**
 * Heuristic: does this assistant message read like a COMPLETION ("klart",
 * "fixat", "shipped", "vX.Y.Z ute", "✅")? Used to split the "finished" bucket
 * into ✅ genuinely-done vs ⚠️ maybe-stalled (got a directive, went quiet, never
 * signalled done). Conservative + tail-anchored like isWaitingLikeText; a
 * miss just shows the pane in the wrong-but-adjacent bucket, never hides it.
 */
export function looksDone(text) {
  if (!text) return false;
  const tail = text.trim().slice(-300).toLowerCase();
  if (!tail) return false;
  // Negated completions ("inte klart", "inte fixat än") are NOT done.
  if (/\b(inte|ej|inte riktigt|not)\s+(klar|klart|fixat|färdig|done|ready)/.test(tail)) return false;
  const cues = [
    /\bklar(t|a)?\b/, /\bfärdig(t|a)?\b/, /\bfixat\b/, /\blöst\b/, /\bklarade\b/,
    /\bshippa(d|t)\b|\bshipped\b/, /\bcommit(ted|ta(t|d))\b/, /\bpusha(t|d)\b|\bpushed\b/, /\bmerg(ed|at|ad)\b/,
    /\bdeploya(t|d|de)|deployed\b/, /\bute\b.*\bv?\d/, /\bv?\d+\.\d+\.\d+.*\bute\b/,
    /\bdone\b/, /\bcomplete[d]?\b/, /\bfinished\b/, /✅/, /\bredo\b/,
  ];
  return cues.some((r) => r.test(tail));
}

/**
 * Classify a pane bucket + its current live status into one of four
 * orchestrator-facing categories. Order matters: "still-working" wins
 * over everything because an active run is the most time-sensitive
 * signal; "waiting" beats "finished" because blocking-on-user is the
 * second-most-actionable.
 */
export function classifyPane(bucket, paneStatus) {
  if (isLiveStatus(paneStatus)) return "still-working";
  if (needsHumanStatus(paneStatus)) return "waiting";

  if (bucket.turns === 0) return "idle";

  if (isWaitingLikeText(bucket.lastAssistantText)) return "waiting";
  return "finished";
}

/**
 * Shorten a message for one-line preview: strip newlines, collapse spaces,
 * trim to ~80 chars with ellipsis. Tool-call noise is already filtered out
 * by groupByPane (only text rows feed the preview slots), so this just
 * handles shape.
 */
export function previewText(text, maxChars = 80) {
  if (!text) return "";
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return collapsed.slice(0, maxChars - 1) + "…";
}
