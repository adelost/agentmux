import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { nightlyUnresolvedCount } from "./nightly-compact.mjs";

/** WHAT: Reads the existing maintenance report for the current verified product. WHY: Prevents an old failed schedule or an unrelated successful compact pass from misreporting repaired Dream health. */
export function readDreamCompletion({ home, dateKey, runId, sourceSha256, createdAt, now = new Date() }) {
  const directory = join(home, ".agentmux", "nightly-compact", dateKey, "runs");
  let names;
  try { names = readdirSync(directory); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const path = join(directory, name), record = JSON.parse(readFileSync(path, "utf8"));
    if (record.dream?.runId !== runId) continue;
    const finishedMs = Date.parse(record.observedAt);
    if (record.dateKey !== dateKey || record.dream.sourceSha256 !== sourceSha256
        || record.unresolved !== 0 || !Array.isArray(record.rows) || !record.policy
        || nightlyUnresolvedCount(record.rows, record.policy) !== 0
        || !Number.isFinite(finishedMs) || finishedMs < Date.parse(createdAt) || finishedMs > now.getTime()) {
      throw new Error("dream-completion-invalid");
    }
    return { path, finishedAt: record.observedAt, unresolved: 0 };
  }
  return null;
}
