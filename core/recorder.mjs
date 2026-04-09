// Request recorder — persists real Discord requests as replay fixtures.
// Each recording captures what went into extract + what came out, so
// extract changes can be regression-tested against real data.

import { writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

const DEFAULT_MAX_RECORDINGS = 500;

/**
 * Create a recorder that writes recordings to a directory.
 * Safe to call with dir=null (no-op recorder) so callers don't need a conditional.
 *
 * @param {object} opts
 * @param {string|null} opts.dir - target directory, or null for a no-op recorder
 * @param {number} [opts.maxRecordings=500] - keep at most this many recordings;
 *   on each save, files beyond this count (oldest by mtime) are deleted.
 *   Set to 0 / Infinity to disable rotation.
 */
export function createRecorder({ dir, maxRecordings = DEFAULT_MAX_RECORDINGS }) {
  if (!dir) {
    return { save: () => {}, enabled: false };
  }

  mkdirSync(dir, { recursive: true });

  function save(recording) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeAgent = (recording.agent || "unknown").replace(/[^a-z0-9_-]/gi, "_");
    const file = join(dir, `${ts}-${safeAgent}-p${recording.pane ?? 0}.json`);
    try {
      writeFileSync(file, JSON.stringify(recording, null, 2));
    } catch (err) {
      console.warn(`recorder: failed to save ${file}: ${err.message}`);
      return;
    }
    if (maxRecordings > 0 && isFinite(maxRecordings)) {
      pruneOldRecordings(dir, maxRecordings);
    }
  }

  return { save, enabled: true };
}

/**
 * Delete recordings beyond the keep count, oldest-first by mtime.
 * Runs after every save so the dir size stays bounded even during long
 * agentus runs (previously it grew unbounded and eventually filled disk).
 */
function pruneOldRecordings(dir, keep) {
  let files;
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime); // newest first
  } catch (err) {
    console.warn(`recorder: prune list failed: ${err.message}`);
    return;
  }
  if (files.length <= keep) return;

  for (const f of files.slice(keep)) {
    try {
      unlinkSync(join(dir, f.name));
    } catch (err) {
      console.warn(`recorder: prune unlink ${f.name} failed: ${err.message}`);
    }
  }
}
