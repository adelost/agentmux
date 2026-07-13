// Clock-free JSONL delivery receipts.
//
// A cursor records each current append-only file's byte size before a prompt
// is sent. Verification parses only bytes appended after those positions (or
// a newly-created session file from byte zero). This distinguishes identical
// repeated prompts without comparing timestamps produced by Discord and the
// local coding-agent process.

import { closeSync, fstatSync, openSync, readSync, statSync } from "fs";

const DEFAULT_MAX_APPEND_BYTES = 8 * 1024 * 1024;

export function captureJsonlAppendCursor(kind, files) {
  const positions = {};
  for (const file of new Set((files || []).filter(Boolean))) {
    try { positions[file] = statSync(file).size; }
    catch { /* a rotating session may disappear between list and stat */ }
  }
  return { kind, positions };
}

function readAppendedText(file, offset, maxBytes) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    let start = Number(offset);
    if (!Number.isFinite(start) || start < 0 || start > size) start = 0;
    const length = Math.min(Math.max(0, size - start), maxBytes);
    if (length === 0) return "";

    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf-8");

    // A cursor normally sits just after a complete JSONL newline. If capture
    // raced a partially written line, discard only that partial continuation;
    // the next complete appended event remains eligible.
    if (start > 0) {
      const previous = Buffer.alloc(1);
      readSync(fd, previous, 0, 1, start - 1);
      if (previous[0] !== 0x0a) {
        const newline = text.indexOf("\n");
        text = newline === -1 ? "" : text.slice(newline + 1);
      }
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

export function jsonlEventsAfterCursor(files, cursor, { maxBytes = DEFAULT_MAX_APPEND_BYTES } = {}) {
  const positions = cursor?.positions && typeof cursor.positions === "object"
    ? cursor.positions
    : {};
  const events = [];
  for (const file of new Set((files || []).filter(Boolean))) {
    const text = readAppendedText(file, positions[file] ?? 0, maxBytes);
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch { /* a final line may still be in flight; the next poll rereads it */ }
    }
  }
  return events;
}
