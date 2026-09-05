import { countWorkTurnsSince, findLatestCompactTs } from "./jsonl-reader.mjs";
import { alternateSessionReader } from "./alternate-session-reader.mjs";
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
