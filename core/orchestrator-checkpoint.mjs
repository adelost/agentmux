// Orchestrator-facing primitives for "what's been done since last check?"
// Pure functions — state read/write lives at the edges so callers can inject
// fake paths in tests. Complements jsonl-reader (raw event stream) and
// getPaneStatus (current snapshot) by answering a different question:
// "which panes finished, which are waiting on me, what did they last say?"

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export const CHECKPOINT_PATH =
  process.env.AMUX_CHECKPOINT_PATH ||
  "/tmp/agentmux-orchestrator-check.json";

/**
 * Load last-check timestamp from a JSON file. Returns null if file missing
 * or malformed — caller picks a fallback anchor (e.g. 1h ago).
 */
export function loadCheckpoint(path = CHECKPOINT_PATH) {
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    const ts = parsed?.last_check_ts_ms;
    return Number.isFinite(ts) ? ts : null;
  } catch {
    return null;
  }
}

export function saveCheckpoint(tsMs, path = CHECKPOINT_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ last_check_ts_ms: tsMs }, null, 2) + "\n");
}

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
 * Classify a pane bucket + its current live status into one of four
 * orchestrator-facing categories. Order matters: "still-working" wins
 * over everything because an active run is the most time-sensitive
 * signal; "waiting" beats "finished" because blocking-on-user is the
 * second-most-actionable.
 */
export function classifyPane(bucket, paneStatus) {
  if (paneStatus === "working" || paneStatus === "resume") return "still-working";
  if (paneStatus === "menu" || paneStatus === "permission") return "waiting";

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
