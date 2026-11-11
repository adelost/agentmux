// WHAT: Follows session journals from a saved offset: a tail read returns the same records as a fresh window read,
// but only the bytes appended since the last read are read and parsed.
// WHY: The watcher reread a 4 MiB tail on every change of a working journal, 38.7 MB per 10 s at 9 reads per 10 s
// (read meter 2026-11-10 23:55-00:00Z); pulse-7 asks a journal be read only from its saved offset (row 116d).
// Held records cost memory (about 14 MB for a parsed 4 MiB tail), so only the most recently read journals are held.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const NEWLINE = 0x0a;

function parseLine(buffer, from, to) {
  const text = buffer.toString("utf8", from, to);
  if (!text.trim()) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
}

/** WHAT: Reads bytes [from, size) of an open file. WHY: One bounded read per call, never the whole file. */
function readRange(fd, from, size) {
  const buffer = Buffer.alloc(size - from);
  let done = 0;
  while (done < buffer.length) {
    const n = readSync(fd, buffer, done, buffer.length - done, from + done);
    if (n <= 0) break;
    done += n;
  }
  return buffer.subarray(0, done);
}

/** WHAT: Splits bytes read at `base` into complete lines with their start offsets, and the unterminated rest. */
function splitLines(buffer, base, records) {
  let lineStart = 0;
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] !== NEWLINE) continue;
    const record = parseLine(buffer, lineStart, i);
    if (record !== undefined) records.push({ start: base + lineStart, record });
    lineStart = i + 1;
  }
  return base + lineStart;   // the offset of the first byte not yet in a complete line
}

/** WHAT: The first byte a kept record may start at: a window that reaches the file start keeps every line. */
const firstKept = (size, windowBytes) => size <= windowBytes ? -Infinity : size - windowBytes + 1;

/**
 * WHAT: Builds a follower: `tail(path, windowBytes)` returns the records `parseJsonlText(readTailWindow(path, windowBytes).text)` would.
 * WHY: A held journal is read from its offset; a new, replaced, truncated or evicted one is read as a window again.
 */
export function createJournalFollower({ maxJournals = 12, log = () => {} } = {}) {
  const held = new Map();   // path -> { dev, ino, offset, windowBytes, records: [{ start, record }] }

  function load(fd, path, stat, windowBytes) {
    const from = Math.max(0, stat.size - windowBytes);
    const records = [];
    const offset = splitLines(readRange(fd, from, stat.size), from, records);
    // A window that starts inside the file begins with a line cut at `from`: readTailWindow drops it.
    const kept = from > 0 ? records.filter((entry) => entry.start >= from + 1) : records;
    return { dev: stat.dev, ino: stat.ino, offset, windowBytes, records: kept };
  }

  function tail(path, windowBytes) {
    let fd;
    try {
      fd = openSync(path, "r");
      const stat = fstatSync(fd);
      let state = held.get(path);
      if (state && (state.dev !== stat.dev || state.ino !== stat.ino || stat.size < state.offset)) {
        log(`journal follower: ${path} was replaced or truncated; reading its window again`);
        state = null;
      }
      if (!state || windowBytes > state.windowBytes) state = load(fd, path, stat, windowBytes);
      else if (stat.size > state.offset) {
        state.offset = splitLines(readRange(fd, state.offset, stat.size), state.offset, state.records);
      }
      // Keep what the largest window asked of this journal needs; a record starts after the newline that ends the one before.
      const heldFrom = firstKept(stat.size, state.windowBytes);
      if (state.records.length && state.records[0].start < heldFrom) {
        const first = state.records.findIndex((entry) => entry.start >= heldFrom);
        state.records = first === -1 ? [] : state.records.slice(first);
      }
      held.delete(path);
      held.set(path, state);
      while (held.size > maxJournals) held.delete(held.keys().next().value);

      const from = firstKept(stat.size, windowBytes);
      const records = state.records.filter((entry) => entry.start >= from).map((entry) => entry.record);
      // An unterminated last line is part of a window read when it parses; it is read again until its newline arrives.
      if (stat.size > state.offset && state.offset >= from) {
        const rest = parseLine(readRange(fd, state.offset, stat.size), 0, stat.size - state.offset);
        if (rest !== undefined) records.push(rest);
      }
      return records;
    } catch {
      held.delete(path);
      return [];
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
  }

  return { tail, size: () => held.size };
}
