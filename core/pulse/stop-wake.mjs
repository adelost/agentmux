// WHAT: Follows the hook ledger (events.jsonl) from its offset and wakes a pane's mirror when the pane's Stop hook fires.
// WHY: A turn end reached the mirror 1.51 s after its Stop hook (median of 105, 10 Nov 23:15Z-00:10Z), behind the journal's
// 500 ms debounce and a poll sweep of every pane; row 116d asks turn ends be seen within 1 s (DESIGN-pulse seq-journal).

import { closeSync, fstatSync, openSync, readSync, watch } from "node:fs";
import { basename, dirname } from "node:path";
import { eventsPath } from "../events.mjs";

const NEWLINE = 0x0a;

/**
 * WHAT: Marks where the hook ledger ends now, so a follower started later reads the stops written in between.
 * WHY: The watcher starts only after Discord is ready (index.mjs:457), 16 s and more after the bridge (skybar:2, 11 Nov 01:52Z).
 */
export function stopLedgerMark(path = eventsPath()) {
  try { const fd = openSync(path, "r"); try { const stat = fstatSync(fd); return { ino: stat.ino, offset: stat.size }; } finally { closeSync(fd); } }
  catch { return { ino: null, offset: 0 }; }   // no ledger yet: it is read from 0 once it appears
}

/**
 * WHAT: Starts following from `from` (default: the ledger's end now): each appended `stop` event calls `wake(session, pane)`.
 * WHY: The poll and the journal's fs.watch still cover a missed event; this path only makes the common case fast.
 */
export function followStopEvents({ wake, path = eventsPath(), from = stopLedgerMark(path), log = () => {}, watchDir = watch } = {}) {
  let { ino, offset } = from;

  function read() {
    let fd;
    try {
      fd = openSync(path, "r");
      const stat = fstatSync(fd);
      // The ledger is rotated by renaming a trimmed copy over it: a new inode or a shorter file starts again at 0.
      if (stat.ino !== ino || stat.size < offset) { ino = stat.ino; offset = 0; }
      if (stat.size <= offset) return;
      const buffer = Buffer.alloc(stat.size - offset);
      const n = readSync(fd, buffer, 0, buffer.length, offset);
      const end = buffer.lastIndexOf(NEWLINE, n - 1);
      if (end === -1) return;   // half a line: read again when its newline arrives
      for (const line of buffer.toString("utf8", 0, end).split("\n")) {
        if (!line.includes('"stop"')) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.event === "stop" && event.session && Number.isInteger(event.pane)) wake(event.session, event.pane);
      }
      offset += end + 1;
    } catch (error) {
      if (error?.code !== "ENOENT") log(`stop wake: ${error.message}`);
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
  }

  read();   // the stops written since the mark
  let watcher = null;
  try {
    watcher = watchDir(dirname(path), { persistent: false }, (_type, name) => { if (!name || String(name) === basename(path)) read(); });
    watcher.on?.("error", (error) => log(`stop wake watch error: ${error.message}`));
  } catch (error) { log(`stop wake not watching ${path}: ${error.message}`); }
  return { read, close: () => { try { watcher?.close(); } catch {} } };
}
