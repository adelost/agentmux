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
        lastAssistantText: null,
      });
    }
    const b = buckets.get(key);
    b.turns++;
    if (r.timestamp) {
      const t = Date.parse(r.timestamp);
      if (Number.isFinite(t) && (b.latestTurnTs == null || t > b.latestTurnTs)) {
        b.latestTurnTs = t;
      }
    }
    if (r.type === "text" || r.type == null) {
      if (r.role === "user" && r.content) b.lastUserText = r.content;
      if (r.role === "assistant" && r.content) b.lastAssistantText = r.content;
    }
  }
  return buckets;
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
