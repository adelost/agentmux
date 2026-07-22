// Conversation activity shared by auto-compact and pane sleep.
// Journal mtime is not user activity: runtimes append housekeeping records
// while idle, so only a real turn may refresh an established session.

import { statSync } from "node:fs";
import { readLastTurns } from "./jsonl-reader.mjs";
import { readLastTurnsCodex } from "./codex-jsonl-reader.mjs";
import { readLastTurnsKimi } from "./kimi-jsonl-reader.mjs";
import { resolveActivityMs } from "./auto-compact.mjs";

// A measured 201 MB Claude journal needed a 256 KiB tail to recover its last
// complete turn. Stop at 1 MiB: parsing an 8 MiB tail across the fleet expanded
// one read-only sweep to 1.6 GiB RSS. If a single record is larger, activity is
// honestly unknown and both compact and sleep fail closed.
const TAIL_SIZES = Object.freeze([64 * 1024, 256 * 1024, 1024 * 1024]);

const DEFAULT_READERS = Object.freeze({
  claude: readLastTurns,
  codex: readLastTurnsCodex,
  kimi: readLastTurnsKimi,
});

/** WHAT: Returns the newest real conversational turn. WHY: Keeps journal maintenance writes from posing as operator activity. */
export function latestConversationActivityMs(paneDir, dialect, {
  readers = DEFAULT_READERS,
  stat = statSync,
} = {}) {
  const reader = readers[dialect];
  if (typeof reader !== "function") return null;

  let result = null;
  let newest = null;
  let tailBytes = TAIL_SIZES[0];
  for (const size of TAIL_SIZES) {
    tailBytes = size;
    result = reader(paneDir, { limit: 1, tailBytes: size });
    newest = result?.turns?.[result.turns.length - 1] || null;
    if (newest || !result) break;
  }
  if (!result) return null;

  const turnMs = newest?.timestamp ? Date.parse(newest.timestamp) : NaN;
  let fileMtimeMs = NaN;
  let fileFullyRead = false;
  if (result.jsonlFile) {
    try {
      const metadata = stat(result.jsonlFile);
      fileMtimeMs = metadata.mtimeMs;
      fileFullyRead = metadata.size <= tailBytes;
    } catch { /* unreadable evidence stays unknown */ }
  }
  return resolveActivityMs({ turnMs, fileMtimeMs, fileFullyRead });
}
