// Reads the ask ledgers a little at a time, for guards that run on every agent send.
// Canonical day files and retained legacy archives use the same discovery as normal log readers.

import {
  closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { askLedgerFiles } from "./ask-ledger-paths.mjs";

/** WHAT: Returns the live ask ledger and its archives with size, inode and time. WHY: Keeps a renamed archive recognised by its inode. */
export function ledgerFiles(ledgerPath) {
  try {
    return askLedgerFiles(ledgerPath).map((path) => {
      const stat = statSync(path);
      return { path, size: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs };
    });
  } catch { return []; }
}

/** WHAT: Reads a file's whole lines from an offset. WHY: Prevents a line still being written from being read half. */
export function readWholeLinesFrom(file, offset) {
  const length = Math.max(0, file.size - offset);
  const buffer = Buffer.alloc(length);
  const fd = openSync(file.path, "r");
  try { readSync(fd, buffer, 0, length, offset); } finally { closeSync(fd); }
  // Only whole lines advance the offset; a line still being written is read next time.
  const end = buffer.lastIndexOf(0x0a) + 1;
  return { text: buffer.subarray(0, end).toString("utf8"), offset: offset + end };
}

/** WHAT: Reads a scan cache, or an empty one of this version. WHY: Keeps a cache of another shape from being trusted. */
export function readScanCache(path, version) {
  try {
    const cache = JSON.parse(readFileSync(path, "utf8"));
    return cache?.version === version && cache.files ? cache : { version, files: {} };
  } catch { return { version, files: {} }; }
}

/** WHAT: Saves a scan cache in one rename. WHY: Prevents a crash from leaving half a cache. */
export function writeScanCache(path, cache) {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
    renameSync(temporary, path);
  } catch { /* the cache only saves time; the next send reads the ledger again */ }
}
