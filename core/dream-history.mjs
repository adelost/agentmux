// Reads each pane's journal back to the start of its Dream window. A fixed
// tail is not enough: on 2026-09-16 a 0.52 MiB tool output hid all but
// skyvw:5's newest prompt, and the receipt then moved past 20 unread turns.

import { statSync } from "node:fs";
import { claudeProjectDir } from "./claude-paths.mjs";
import { CODEX_DREAM_SCAN_BYTES as DREAM_SCAN_BYTES } from "./codex-dream-history.mjs";
import { readLastTurnsCodex } from "./codex-jsonl-reader.mjs";
import { isDreamActivityTurn } from "./dream-eligibility.mjs";
import { groupIntoTurns, listJsonlFiles, parseJsonlWindow } from "./jsonl-reader.mjs";
import { readLastTurnsKimi } from "./kimi-jsonl-reader.mjs";

/** WHAT: Defines the first journal window. WHY: Keeps a quiet pane's nightly read as cheap as a live tail. */
const FIRST_WINDOW_BYTES = 512 * 1024;
/** WHAT: Defines the adaptive tail ceiling before Codex's cold scan. WHY: Keeps full-record parsing from growing without bound. */
const TAIL_WINDOW_BYTES = 8 * 1024 * 1024;
/** WHAT: Defines how many turns one read may return. WHY: Keeps a reader's newest-turn cut from hiding a window's start. */
export const DREAM_HISTORY_TURNS = 512;
/** WHAT: Defines how many rotated Claude sessions one read may open. WHY: Keeps frequent compaction from multiplying nightly reads. */
const CLAUDE_SESSION_FILES = 6;

const timeMs = (value) => Date.parse(value?.timestamp || "");
const reachesWindowStart = (records, sinceMs) => records.some((record) => timeMs(record) <= sinceMs);

function newestFirstCut(turns, limit) {
  return turns.length > limit ? { turns: turns.slice(-limit), cut: true } : { turns, cut: false };
}

/** WHAT: Reads Claude turns across rotated sessions back to a window start. WHY: Keeps a compact rotation or a large tool result from hiding unsummarized work. */
export function readClaudeTurnsSince(paneDir, {
  since, limit = DREAM_HISTORY_TURNS, maxFiles = CLAUDE_SESSION_FILES, maxBytes = DREAM_SCAN_BYTES,
} = {}) {
  const sinceMs = since.getTime();
  const files = listJsonlFiles(claudeProjectDir(paneDir));
  const touched = files.filter((file, index) => index === 0 || file.mtime >= sinceMs);
  const selected = touched.slice(0, maxFiles);
  let reachedSince = touched.length === selected.length;
  const turns = selected.flatMap(({ path }) => {
    const events = parseJsonlWindow(path, {
      initialBytes: FIRST_WINDOW_BYTES, maxBytes, enough: (window) => reachesWindowStart(window, sinceMs),
    });
    if (!reachesWindowStart(events, sinceMs) && statSync(path).size > maxBytes) reachedSince = false;
    return groupIntoTurns(events, { headless: true });
  }).filter((turn) => timeMs(turn) >= sinceMs).sort((left, right) => timeMs(left) - timeMs(right));
  const unique = [...new Map(turns.map((turn) => [`${turn.timestamp}\u0000${turn.userPrompt}`, turn])).values()];
  const kept = newestFirstCut(unique, limit);
  return {
    turns: kept.turns, filesRead: selected.length, filesOmitted: touched.length - selected.length,
    reachedSince: reachedSince && !kept.cut, lastWriteMs: files[0]?.mtime ?? null,
  };
}

/** WHAT: Reads a Codex or Kimi tail grown until it reaches a window start. WHY: Keeps the newest prompt from standing in for a whole night's work. */
export function readTailTurnsSince(engine, paneDir, {
  since, limit = DREAM_HISTORY_TURNS, stat = statSync, reader = engine === "codex" ? readLastTurnsCodex : readLastTurnsKimi,
} = {}) {
  const sinceMs = since.getTime();
  let tail = null;
  for (let tailBytes = FIRST_WINDOW_BYTES; tailBytes <= TAIL_WINDOW_BYTES; tailBytes *= 2) {
    const result = reader(paneDir, { limit, tailBytes, headless: true });
    if (!result?.jsonlFile) return { turns: result?.turns || [], reachedSince: true, lastWriteMs: null };
    const journal = stat(result.jsonlFile);
    tail = { ...result, reachedSince: false, lastWriteMs: journal.mtimeMs };
    if (journal.size <= tailBytes || journal.mtimeMs <= sinceMs || reachesWindowStart(result.turns, sinceMs)) {
      return { ...tail, reachedSince: true };
    }
  }
  return engine === "codex" ? readCodexColdHistory(paneDir, { sinceMs, limit, stat, reader, tail }) : tail;
}

// A record the cold scan cannot classify is permanent: the journal only grows,
// so failing the pane would hide it from every later Dream. Keep what the tail
// proved and state the gap; with no attributable work there is nothing to keep.
function readCodexColdHistory(paneDir, { sinceMs, limit, stat, reader, tail }) {
  const hasWork = (turns) => turns.some((turn) => isDreamActivityTurn(turn.userPrompt));
  let recovered;
  try { recovered = reader(paneDir, { limit, dreamHistory: true }); }
  catch (error) {
    if (hasWork(tail.turns)) return tail;
    throw error;
  }
  const journal = stat(recovered.jsonlFile);
  const reachedSince = journal.size <= DREAM_SCAN_BYTES || reachesWindowStart(recovered.turns, sinceMs);
  if (!reachedSince && !hasWork(recovered.turns)) {
    if (hasWork(tail.turns)) return tail;
    throw new Error("dream-history-window-exhausted: no attributable work in bounded 64MiB recovery");
  }
  return { ...recovered, reachedSince: reachedSince && recovered.turns.length < limit, lastWriteMs: journal.mtimeMs };
}

/** WHAT: Reads one pane's turns since its Dream window start. WHY: Keeps engine journal formats out of Dream's selection rules. */
export function readDreamPaneHistory(engine, paneDir, options) {
  return engine === "claude" ? readClaudeTurnsSince(paneDir, options) : readTailTurnsSince(engine, paneDir, options);
}
