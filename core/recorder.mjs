// Request recorder. Persists real Discord requests as replay fixtures.
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
    if (!isUsableRecording(recording)) {
      console.warn(
        `recorder: skipping ${recording.agent}:p${recording.pane} - ` +
        `prompt "${(recording.prompt || "").slice(0, 40)}" not in raw ` +
        `(pane likely hidden or buffer overflowed before capture)`
      );
      return;
    }
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

// A recording is replay-usable iff the captured raw buffer contains the
// prompt that was sent. If it doesn't, the pane was hidden (width=1) or
// busy enough that the prompt scrolled past the 5000-line capture window.
// Such recordings can't exercise the extract pipeline meaningfully.
//
// Whitespace is collapsed to handle terminal wordwrap on narrow panes —
// same convention as the replay sanity-check test.
export function isUsableRecording(recording) {
  if (!recording) return false;
  // Only validate when both fields look like a real tmux capture. Partial
  // fixtures (no raw / no prompt) are accepted — they don't claim to be
  // replay material.
  if (typeof recording.raw !== "string" || typeof recording.prompt !== "string") return true;
  if (!recording.raw || !recording.prompt) return true;
  if (recording.source && recording.source !== "tmux") return true; // jsonl-sourced recordings have synthesized raw, no echo expected
  const collapse = (s) => s.replace(/\s+/g, "");
  const head = recording.prompt.slice(0, Math.min(20, recording.prompt.length));
  return collapse(recording.raw).includes(collapse(head));
}

/**
 * Delete recordings beyond the keep count, oldest-first by mtime.
 * Runs after every save so the dir size stays bounded even during long
 * agentmux runs (previously it grew unbounded and eventually filled disk).
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
