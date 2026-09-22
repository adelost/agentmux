// Bounded Qwen JSONL reads. A large journal is a window, not an empty history.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";

const MAX_WINDOW_BYTES = 16 * 1024 * 1024;

/** WHAT: Reads complete records in a bounded head/tail window. WHY: Long-running panes must not disappear at a file-size threshold. */
export function readQwenJournalWindow(file, { head = false, maxBytes = MAX_WINDOW_BYTES } = {}) {
  const budget = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, MAX_WINDOW_BYTES) : MAX_WINDOW_BYTES;
  let fd;
  try {
    fd = openSync(file, "r");
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { events: [], truncated: false };
    const start = head ? 0 : Math.max(0, stat.size - budget);
    const length = Math.min(stat.size - start, budget);
    const buffer = Buffer.alloc(length);
    let used = 0;
    while (used < length) {
      const n = readSync(fd, buffer, used, length - used, start + used);
      if (!n) break;
      used += n;
    }
    let first = 0;
    if (start > 0) {
      const previous = Buffer.alloc(1);
      readSync(fd, previous, 0, 1, start - 1);
      if (previous[0] !== 0x0a) {
        const newline = buffer.indexOf(0x0a, 0);
        first = newline < 0 || newline >= used ? used : newline + 1;
      }
    }
    const events = buffer.subarray(first, used).toString("utf8").split("\n").filter(Boolean).flatMap((line) => {
      try {
        const value = JSON.parse(line);
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        return [{ ...value, __file: file,
          __id: createHash("sha256").update(line).digest("hex").slice(0, 20) }];
      } catch { return []; }
    });
    return { events, truncated: stat.size > budget };
  } catch { return { events: [], truncated: false }; }
  finally { if (fd !== undefined) closeSync(fd); }
}
