import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { nightlyUnresolvedCount } from "./nightly-compact.mjs";

/** WHAT: Reads the existing maintenance report for the current verified product. WHY: Prevents an old failed schedule or an unrelated successful compact pass from misreporting repaired Dream health. */
export function readDreamCompletion({ home, dateKey, runId, sourceSha256, createdAt, now = new Date() }) {
  const directory = join(home, ".agentmux", "nightly-compact", dateKey, "runs");
  let names;
  try { names = readdirSync(directory); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const passes = names.filter(name => name.endsWith(".json")).map(name => {
    const path = join(directory, name);
    return { path, record: JSON.parse(readFileSync(path, "utf8")) };
  }).filter(({ record }) => record.dream?.runId === runId);
  const time = pass => Number.isFinite(Date.parse(pass.record.observedAt)) ? Date.parse(pass.record.observedAt) : Infinity;
  // A later genuine pass can resolve an earlier uncertain observation. Never
  // choose an arbitrary directory entry, or revive an older green pass.
  passes.sort((a, b) => time(b) - time(a));
  for (const { path, record } of passes.slice(0, 1)) {
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
