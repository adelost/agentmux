import { countWorkTurnsSince, findLatestCompactTs } from "./jsonl-reader.mjs";
import { alternateSessionReader, sessionReaderForCommand } from "./alternate-session-reader.mjs";
import { isWorkDirective } from "./system-noise.mjs";

/** WHAT: Reads bounded reminder activity through existing journal readers. WHY: Keeps engine formats and maintenance filtering owned by their canonical modules. */
export function readReminderActivity(paneDir, command, cutoffMs) {
  const reader = alternateSessionReader(command);
  if (!reader) return {
    ...countWorkTurnsSince(paneDir, cutoffMs == null ? null : new Date(cutoffMs)),
    latestCompactTs: findLatestCompactTs(paneDir),
  };
  // Never pass `since` here: Codex's historical filter requests a full parse.
  // An incomplete bounded tail can undercount, but never justifies a wake.
  const snapshot = reader.readTurns(paneDir, { limit: 512, tailBytes: 1024 * 1024 });
  const times = (snapshot?.turns || [])
    .filter((turn) => isWorkDirective(turn.userPrompt))
    .map((turn) => Date.parse(turn.timestamp || ""))
    .filter((time) => Number.isFinite(time) && (cutoffMs == null || time > cutoffMs));
  const compactions = (snapshot?.compactions || []).map((item) => Date.parse(item.timestamp || "")).filter(Number.isFinite);
  return {
    count: times.length,
    latest: times.length ? new Date(Math.max(...times)).toISOString() : null,
    latestCompactTs: compactions.length ? Math.max(...compactions) : null,
  };
}

/** WHAT: Names the journal a pane's activity is read from, by path, size and mtime. WHY: An unchanged stamp means an unchanged answer. */
function journalStamp(paneDir, command) {
  return sessionReaderForCommand(command || "").latestInfo(paneDir);
}

/**
 * WHAT: Builds a reminder-activity reader that reads a pane's journal again only after it changed or the cutoff moved.
 * WHY: drift-guard read every idle pane's journal twice a round, 8 MB a read and 32 MB per 10 s (read meter 2026-11-10 23:41Z, row 116d).
 */
export function createReminderActivityReader({ read = readReminderActivity, stamp = journalStamp } = {}) {
  const held = new Map();
  return (paneDir, command, cutoffMs) => {
    const key = JSON.stringify([stamp(paneDir, command), cutoffMs ?? null]);
    const last = held.get(`${command}\0${paneDir}`);
    if (last?.key === key) return last.activity;
    const activity = read(paneDir, command, cutoffMs);
    held.set(`${command}\0${paneDir}`, { key, activity });
    return activity;
  };
}
