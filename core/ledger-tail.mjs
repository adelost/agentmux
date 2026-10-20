// Reads the conversation log a little at a time: the rows added since the last call, and no byte twice.
//
// A caller keeps one small state object between calls (in memory in the search daemon, in a file for the day files of
// his messages). The state is keyed by inode, never by path: a rotation renames the live file and keeps its inode, so
// the renamed file is followed to its end and the new live file starts at 0. Only whole lines advance the offset, so a
// row still being written, even one cut inside a two-byte letter, is read when it is whole.
// The files and their time spans come from core/ask-ledger.mjs, the one module that knows what the log is called.

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { ASK_LEDGER_VERSION, defaultAskLedgerPath, ledgerSpans } from "./ask-ledger.mjs";

/** WHAT: Names the most bytes one call reads. WHY: Keeps a first read of a 30-day log from holding all of it at once. */
export const TAIL_SLICE_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;

/** WHAT: Reads bytes of one file. WHY: Keeps the tail's only file access in one place, so tests can record it. */
export function readRange(file, offset, length) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    let count = 0;
    while (count < length) {
      const read = readSync(fd, buffer, count, length - count, offset + count);
      if (!read) break;
      count += read;
    }
    return count === length ? buffer : buffer.subarray(0, count);
  } finally { closeSync(fd); }
}

// Reads from `start`, at most `budget` bytes unless one line is longer than that.
function readWholeLines(read, file, start, remaining, budget) {
  let length = Math.min(remaining, budget);
  for (;;) {
    const bytes = read(file, start, length);
    const end = bytes.lastIndexOf(NEWLINE) + 1;
    if (end > 0 || length >= remaining) return { bytes, end };
    length = Math.min(remaining, length * 2);
  }
}

function parsedRow(line) {
  try {
    const row = JSON.parse(line);
    return row?.version === ASK_LEDGER_VERSION ? row : null;
  } catch { return null; }
}

/**
 * `done` is false while the slice limit left bytes unread. `rewritten` is true when a file got smaller than it was; the
 * caller then drops what it held and reads again from an empty state. An archive that ends before `sinceMs` and was
 * never read is not opened.
 * WHAT: Returns the rows added to the log since `state`, where each sits, and the next state.
 * WHY: Keeps a question from reading 238 MB of log again.
 */
export function tailLedger(state = {}, { path = defaultAskLedgerPath(), sinceMs = -Infinity, maxBytes = TAIL_SLICE_BYTES,
  files = ledgerSpans, stat = statSync, read = readRange } = {}) {
  const found = [];
  for (const span of files(path)) {
    try { found.push({ span, info: stat(span.file) }); } catch { /* deleted since it was listed: nothing to read */ }
  }
  const next = {};
  const rows = [];
  let budget = maxBytes;
  let done = true;
  let rewritten = false;
  for (const { span, info } of found) {
    const key = String(info.ino);
    let known = state[key];
    if (known && known.size > info.size) { known = undefined; rewritten = true; }
    if (!known && span.lastMs < sinceMs) continue;
    const start = known ? known.offset : 0;
    const remaining = info.size - start;
    if (remaining > 0 && budget <= 0) {
      done = false;
      if (known) next[key] = { ...known, path: span.file };
      continue;
    }
    let end = 0;
    if (remaining > 0) {
      const slice = readWholeLines(read, span.file, start, remaining, budget);
      end = slice.end;
      budget -= slice.bytes.length;
      if (start + slice.bytes.length < info.size) done = false;
      for (let at = 0; at < end;) {
        const stop = slice.bytes.indexOf(NEWLINE, at);
        const row = parsedRow(slice.bytes.toString("utf8", at, stop));
        if (row) rows.push({ row, path: span.file, file: key, offset: start + at, length: stop - at });
        at = stop + 1;
      }
    }
    next[key] = { path: span.file, size: info.size, offset: start + end };
  }
  return { rows, state: next, done, rewritten };
}
