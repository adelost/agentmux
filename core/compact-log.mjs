// lsrc:0 for Mattias 2026-10-21: sandman:0 could not count the night's compacts, since only their outcomes were logged.
// Every compact the bridge or an account move runs leaves one line: time, pane, tokens before and after, account.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** WHAT: Names the compact log. WHY: Keeps the bridge, the rotation and a replay on one file. */
export const COMPACT_LOG = join(homedir(), ".agentmux", "compacts.jsonl");

/** WHAT: Stores one compact call in the log. WHY: Lets a night's compacts be counted; a failed write never changes the compact. */
export function recordCompactCall(entry, path = COMPACT_LOG) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  } catch { /* diagnostics never change compact truth */ }
}
