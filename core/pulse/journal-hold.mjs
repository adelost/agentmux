// WHAT: Holds a small answer derived from a session journal while the journal's stamp is unchanged.
// WHY: An idle journal costs 0 reads (DESIGN-pulse pulse-7, row 116d): drift-guard, Link, auto-compact and the quota
// warning each reread the same unchanged tails, 1-8 MB a read, every round (read meter 2026-11-10 23:41Z).

import { statSync } from "node:fs";

/** WHAT: Names a journal file by path, device, inode, size and mtime. WHY: Any append, rewrite or replacement changes it. */
export function fileStamp(path) {
  if (!path) return null;
  try {
    const stat = statSync(path);
    return [path, stat.dev, stat.ino, stat.size, stat.mtimeMs];
  } catch { return null; }
}

/**
 * WHAT: Builds a hold: `hold(key, stamp, compute)` returns the answer computed for the same key and stamp, else computes it.
 * WHY: A null stamp (no journal found) is never held, so a missing journal is looked for again every call.
 */
export function createJournalHold() {
  const held = new Map();
  return function hold(key, stamp, compute) {
    if (stamp == null) return compute();
    const tag = JSON.stringify(stamp);
    const last = held.get(key);
    if (last?.tag === tag) return last.value;
    const value = compute();
    held.set(key, { tag, value });
    return value;
  };
}
