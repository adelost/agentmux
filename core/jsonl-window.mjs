// Bounded tail reads of append-only session journals, newest events last.
import { openSync, fstatSync, readSync, closeSync } from "fs";

// Long sessions require bounded tail reads to stay below Node string limits.
/** WHAT: Returns the default journal tail. WHY: Keeps one bounded read for thousands of turns. */
export const DEFAULT_JSONL_WINDOW_BYTES = 8 * 1024 * 1024;
/** WHAT: Returns the largest journal read. WHY: Keeps a read below Node's max string length. */
export const MAX_JSONL_WINDOW_BYTES = 128 * 1024 * 1024;

/** WHAT: Parses JSON lines from a string blob, skipping malformed lines. WHY: Keeps one torn line from hiding a journal. */
export function parseJsonlText(content) {
  const events = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return events;
}

/**
 * Read the last `maxBytes` of a file as UTF-8 text, aligned to a line boundary.
 * Returns { text, reachedStart }. When the window does NOT span the whole file
 * the first (partial) line is dropped and reachedStart is false; when it does,
 * the full text is returned and reachedStart is true. UTF-8-safe: a multibyte
 * char split at the window start lands inside the dropped partial line, so a
 * kept line never begins mid-codepoint. Never materialises more than the window.
 * WHAT: Reads a file's line-aligned tail. WHY: Keeps a giant journal from being read whole.
 */
export function readTailWindow(filePath, maxBytes) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    const reachedStart = size <= maxBytes;
    const readBytes = reachedStart ? size : maxBytes;
    const buf = Buffer.alloc(readBytes);
    if (readBytes > 0) readSync(fd, buf, 0, readBytes, size - readBytes);
    let text = buf.toString("utf-8");
    if (!reachedStart) {
      const nl = text.indexOf("\n");
      text = nl === -1 ? "" : text.slice(nl + 1); // discard partial leading line
    }
    return { text, reachedStart };
  } catch {
    return { text: "", reachedStart: false };
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

/**
 * Parse a GROWING tail window until `enough(events)` is satisfied, the window
 * reaches the file start, or it hits `maxBytes`. Doubles the window each pass.
 * Never materialises more than `maxBytes` as a string, so it is safe on files
 * past Node's max string length. `enough` defaults to "the first window is
 * enough" (single bounded tail read).
 * WHAT: Returns events from a tail window grown until enough. WHY: Keeps a reader that needs older events from stopping at the first window.
 */
export function parseJsonlWindow(filePath, {
  initialBytes = DEFAULT_JSONL_WINDOW_BYTES,
  maxBytes = MAX_JSONL_WINDOW_BYTES,
  enough = () => true,
} = {}) {
  let bytes = Math.max(1, Math.min(initialBytes, maxBytes));
  for (;;) {
    const { text, reachedStart } = readTailWindow(filePath, bytes);
    const events = parseJsonlText(text);
    if (reachedStart || bytes >= maxBytes || enough(events)) return events;
    bytes = Math.min(bytes * 2, maxBytes);
  }
}
