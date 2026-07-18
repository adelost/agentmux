// Clock-free JSONL delivery receipts.
//
// A cursor records each current append-only file's byte size before a prompt
// is sent. Verification parses only bytes appended after those positions (or
// a newly-created session file from byte zero). This distinguishes identical
// repeated prompts without comparing timestamps produced by Discord and the
// local coding-agent process.

import { closeSync, fstatSync, openSync, readSync, statSync } from "fs";

const DEFAULT_MAX_APPEND_BYTES = 8 * 1024 * 1024;
const DEFAULT_SCAN_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 2 * 1024 * 1024;

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

/**
 * WHAT: Checks appended JSONL events for one predicate match.
 * WHY: Keeps oversized tool records from hiding later delivery receipts.
 */
export function hasJsonlEventAfterCursor(files, cursor, predicate, {
  chunkBytes = DEFAULT_SCAN_CHUNK_BYTES,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
} = {}) {
  if (typeof predicate !== "function") throw new TypeError("JSONL event predicate is required");
  const positions = cursor?.positions && typeof cursor.positions === "object"
    ? cursor.positions
    : {};
  const readChunkBytes = Math.max(1, Number(chunkBytes) || DEFAULT_SCAN_CHUNK_BYTES);
  const eventLimit = Math.max(1, Number(maxEventBytes) || DEFAULT_MAX_EVENT_BYTES);

  for (const file of new Set((files || []).filter(Boolean))) {
    let fd;
    try {
      fd = openSync(file, "r");
      const size = fstatSync(fd).size;
      let position = Number(positions[file] ?? 0);
      if (!Number.isFinite(position) || position < 0 || position > size) position = 0;

      let discardPartial = false;
      if (position > 0) {
        const previous = Buffer.alloc(1);
        readSync(fd, previous, 0, 1, position - 1);
        discardPartial = previous[0] !== 0x0a;
      }

      let fragments = [];
      let eventBytes = 0;
      let oversized = false;
      const consumeLine = () => {
        if (discardPartial) {
          discardPartial = false;
        } else if (!oversized && eventBytes > 0) {
          try {
            const event = JSON.parse(Buffer.concat(fragments, eventBytes).toString("utf8"));
            if (predicate(event)) return true;
          } catch { /* a malformed/in-flight line is not a receipt */ }
        }
        fragments = [];
        eventBytes = 0;
        oversized = false;
        return false;
      };

      while (position < size) {
        const length = Math.min(readChunkBytes, size - position);
        const buffer = Buffer.allocUnsafe(length);
        const bytesRead = readSync(fd, buffer, 0, length, position);
        if (bytesRead <= 0) break;
        position += bytesRead;

        let start = 0;
        for (let index = 0; index < bytesRead; index++) {
          if (buffer[index] !== 0x0a) continue;
          const segment = buffer.subarray(start, index);
          if (!discardPartial && !oversized && segment.length > 0) {
            if (eventBytes + segment.length <= eventLimit) {
              fragments.push(Buffer.from(segment));
              eventBytes += segment.length;
            } else {
              fragments = [];
              eventBytes = 0;
              oversized = true;
            }
          }
          if (consumeLine()) return true;
          start = index + 1;
        }

        const remainder = buffer.subarray(start, bytesRead);
        if (!discardPartial && !oversized && remainder.length > 0) {
          if (eventBytes + remainder.length <= eventLimit) {
            fragments.push(Buffer.from(remainder));
            eventBytes += remainder.length;
          } else {
            fragments = [];
            eventBytes = 0;
            oversized = true;
          }
        }
      }

      // JSONL writers normally end events with a newline, but a complete last
      // record is still a valid receipt if the process has not flushed '\n' yet.
      if (!discardPartial && !oversized && eventBytes > 0) {
        try {
          const event = JSON.parse(Buffer.concat(fragments, eventBytes).toString("utf8"));
          if (predicate(event)) return true;
        } catch { /* final record is still in flight */ }
      }
    } catch { /* a rotating session may disappear between list and open */ }
    finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
  }
  return false;
}
