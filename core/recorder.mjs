// Request recorder — persists real Discord requests as replay fixtures.
// Each recording captures what went into extract + what came out, so
// extract changes can be regression-tested against real data.

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

/**
 * Create a recorder that writes recordings to a directory.
 * Safe to call with dir=null (no-op recorder) so callers don't need a conditional.
 */
export function createRecorder({ dir }) {
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
    }
  }

  return { save, enabled: true };
}
