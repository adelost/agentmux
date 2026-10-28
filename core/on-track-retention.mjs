// WHAT: Keeps the on-track state to what its readers use and moves the rest to append-only archives.
// WHY: Every save rewrites the whole state file. Closed cycles kept their frozen inputs
//      (decisions, submissions, receipts, about 2.6 MB each), so on 2026-10-28 the file
//      held 78 of them, 238 MB, rewritten one to two times a minute.
import { closeSync, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

/** WHAT: Defines how long closed cycles and command captures stay in the state. WHY: Keeps records past the 24 h statistics window from every save. */
export const ON_TRACK_KEEP_MS = 48 * 3600000;

// What onTrackStatistics, onTrackCoveredUntil and delivery reconciliation read from a closed cycle.
const CYCLE_FIELDS = ["id", "project", "at", "scheduledAt", "missedHours", "baseline", "baselinePolicy", "deadline", "status", "deliveries", "events", "human", "tip"];
const REVIEW_FIELDS = ["valid", "at", "coveredUntil", "deviations", "askLatencyMs"];
const PENDING_DELIVERY = new Set(["queued", "unknown", "attempting"]);

const pick = (record, fields) => Object.fromEntries(fields.filter(field => field in record).map(field => [field, record[field]]));
const isRecent = (at, now, keepMs) => now - at <= keepMs;
const hasPendingDelivery = cycle => Object.values(cycle.deliveries || {}).some(receipt => PENDING_DELIVERY.has(receipt.status));
const lastReviewTimes = data => new Set(Object.values(data.projects || {}).map(record => record?.lastReview?.at).filter(at => at !== undefined));
// A cycle past the window stays while the last valid review or a pending delivery still points to it.
const keepsCycle = (cycle, now, keepMs, reviewed) => isRecent(cycle.at, now, keepMs) || hasPendingDelivery(cycle) || reviewed.has(cycle.review?.at);
const commandExpired = (command, now, keepMs) => !isRecent(Date.parse(command.at), now, keepMs);

/** WHAT: Returns the part of a closed cycle that its readers use. WHY: Keeps the frozen input out of the state; the archive holds it whole. */
export const summarizeOnTrackCycle = cycle => ({
  ...pick(cycle, CYCLE_FIELDS), ...(cycle.review ? { review: pick(cycle.review, REVIEW_FIELDS) } : {}), summary: true,
});

/** WHAT: Checks whether retention would change the state. WHY: Prevents a tick with nothing to move from rewriting the file. */
export function onTrackRetentionDue(data, now, keepMs = ON_TRACK_KEEP_MS) {
  const reviewed = lastReviewTimes(data);
  return (data.history || []).some(cycle => !cycle.summary || !keepsCycle(cycle, now, keepMs, reviewed))
    || Object.values(data.commands || {}).some(command => commandExpired(command, now, keepMs));
}

/**
 * WHAT: Filters closed cycles and command captures to the summaries and window the readers use.
 * WHY: Keeps the state file from growing with each hourly cycle; returns what left for the archive.
 */
export function retainOnTrackState(data, now, keepMs = ON_TRACK_KEEP_MS) {
  const reviewed = lastReviewTimes(data), cycles = [], commands = [];
  data.history = (data.history || []).flatMap(cycle => {
    if (!cycle.summary) cycles.push(cycle);
    if (!keepsCycle(cycle, now, keepMs, reviewed)) return [];
    return [cycle.summary ? cycle : summarizeOnTrackCycle(cycle)];
  });
  for (const [key, command] of Object.entries(data.commands || {})) {
    if (!commandExpired(command, now, keepMs)) continue;
    commands.push({ key, ...command });
    delete data.commands[key];
  }
  return { cycles, commands };
}

/** WHAT: Saves what left the state to history.jsonl and commands.jsonl in dir, synced. WHY: Keeps old records readable without rewriting them on every save. */
export function appendOnTrackArchive(dir, { cycles, commands }) {
  appendJsonLines(join(dir, "history.jsonl"), cycles);
  appendJsonLines(join(dir, "commands.jsonl"), commands);
}

const appendJsonLines = (path, records) => {
  if (!records.length) return;
  const fd = openSync(path, "a", 0o600);
  try {
    for (const record of records) writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
};
