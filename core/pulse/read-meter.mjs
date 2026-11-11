// WHAT: Counts the bytes the bridge reads from files, by reader and by kind of file, while ~/.agentmux/read-meter.on exists.
// WHY: Row 124: the bridge read 451 MB per 10 s (rchar) at 74 % of a core on 10 Nov 2026; ptrace is shut (ptrace_scope 1) and its reads
// leave no file position to sample, so the bridge counts its own. Off, a read costs one flag check; the flag is read every 15 s.

import fs from "node:fs";
import fsp from "node:fs/promises";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { dirname, join } from "node:path";
import { askerOf } from "./asker.mjs";

/** WHAT: Names the meter's switch and its counter file. WHY: Keeps the bridge and the reader of the counts on one path. */
export const READ_METER_FLAG = join(homedir(), ".agentmux", "read-meter.on");
export const READ_METER_PATH = join(homedir(), ".agentmux", "read-meter.json");
const WRITE_EVERY_MS = 15_000;
const MAX_READERS = 200;
const MAX_JOURNALS = 2_000;   // one entry per session journal read, so an idle journal that is still read shows by name (row 116d);
// the Codex session catalog reads all 637 rollouts once at start, which filled a 400 cap (11 Nov 00:05Z)
const JOURNAL_KINDS = new Set(["claude journal", "codex rollout"]);
const CARRIERS = new Set(["core/pulse/read-meter.mjs", "index.mjs", "lib.mjs"]);
// A journal read passes three reader functions before the watcher that pays for it (readTailWindow < parseJsonlTail < readLastTurns).
const READER_FRAMES = 6;

/** WHAT: Names a file by its kind, never its own name: a Claude journal, a Codex rollout, an agentmux state file. WHY: Groups the cost by what is read. */
export function kindOf(file) {
  const path = String(file ?? "");
  if (!path) return "unknown";
  if (/\/(?:\.claude|account-profiles\/claude\/[^/]+)\/projects\/.+\.jsonl$/u.test(path)) return "claude journal";
  if (/\/\.codex\/sessions\/.+\.jsonl$/u.test(path)) return "codex rollout";
  const agentmux = /\/\.agentmux\/(.+)$/u.exec(path);
  if (agentmux) return `.agentmux/${agentmux[1].replace(/[0-9a-f-]{8,}|\d+/gu, "#")}`;
  return path.replace(homedir(), "~").replace(/[0-9a-f-]{8,}|\d+/gu, "#");
}

/**
 * WHAT: Wraps node's file reads once (sync, callback, promise and FileHandle) and counts their bytes while the flag file exists.
 * WHY: Keeps the count in the bridge's own process, where the reads are; nothing else changes about any read.
 */
export function startReadMeter({ flag = READ_METER_FLAG, out = READ_METER_PATH, everyMs = WRITE_EVERY_MS, asker = () => askerOf(CARRIERS, { frames: READER_FRAMES }),
  now = () => Date.now() } = {}) {
  let on = existsSync(flag), since = now(), total = 0, calls = 0;
  let byReader = {}, byKind = {}, journals = {};
  const fdPaths = new Map(), handlePaths = new WeakMap();
  let inside = 0;   // readFileSync reads through fs.readSync for a buffer: the outer call counts, the inner one does not
  const count = (bytes, file) => {
    if (!on || !(bytes > 0)) return;
    const kind = kindOf(file), who = asker();
    total += bytes; calls++;
    byKind[kind] = (byKind[kind] ?? 0) + bytes;
    if (JOURNAL_KINDS.has(kind) && (journals[file] || Object.keys(journals).length < MAX_JOURNALS)) {
      const journal = (journals[file] ??= { bytes: 0, calls: 0, readers: {} });
      journal.bytes += bytes; journal.calls++;
      if (journal.readers[who] || Object.keys(journal.readers).length < 8) journal.readers[who] = (journal.readers[who] ?? 0) + bytes;
    }
    if (!byReader[who] && Object.keys(byReader).length >= MAX_READERS) return;
    const reader = (byReader[who] ??= { bytes: 0, calls: 0, kinds: {} });
    reader.bytes += bytes; reader.calls++; reader.kinds[kind] = (reader.kinds[kind] ?? 0) + bytes;
  };
  const sizeOf = (value) => typeof value === "string" ? Buffer.byteLength(value) : value?.byteLength ?? 0;

  const { openSync, closeSync, readSync, readFileSync, open, read } = fs;
  fs.openSync = function meteredOpenSync(path, ...rest) { const fd = openSync.call(this, path, ...rest); fdPaths.set(fd, String(path)); return fd; };
  fs.closeSync = function meteredCloseSync(fd) { fdPaths.delete(fd); return closeSync.call(this, fd); };
  fs.readSync = function meteredReadSync(fd, ...rest) { const n = readSync.call(this, fd, ...rest); if (!inside) count(n, fdPaths.get(fd)); return n; };
  fs.readFileSync = function meteredReadFileSync(path, ...rest) {
    let data;
    inside++;
    try { data = readFileSync.call(this, path, ...rest); } finally { inside--; }
    count(sizeOf(data), typeof path === "number" ? fdPaths.get(path) : path);
    return data;
  };
  fs.open = function meteredOpen(path, ...rest) {
    const done = rest.pop();
    return open.call(this, path, ...rest, (error, fd) => { if (!error) fdPaths.set(fd, String(path)); done(error, fd); });
  };
  fs.read = function meteredRead(fd, ...rest) {
    const done = rest.pop();
    return read.call(this, fd, ...rest, (error, n, buffer) => { if (!error) count(n, fdPaths.get(fd)); done(error, n, buffer); });
  };
  const { readFile, open: openHandle } = fsp;
  fsp.readFile = async function meteredReadFile(path, ...rest) {
    const data = await readFile.call(this, path, ...rest);
    count(sizeOf(data), typeof path === "object" && path ? handlePaths.get(path) : path);
    return data;
  };
  fsp.open = async function meteredOpenHandle(path, ...rest) {
    const handle = await openHandle.call(this, path, ...rest);
    handlePaths.set(handle, String(path));
    return handle;
  };
  syncBuiltinESMExports();   // named imports of node:fs and node:fs/promises see the wrapped functions too
  // FileHandle.read lives on the class; its first instance names the prototype to wrap
  let handleWrapped = false;
  const wrapHandle = (handle) => {
    if (handleWrapped) return;
    handleWrapped = true;
    const proto = Object.getPrototypeOf(handle), handleRead = proto.read;
    proto.read = async function meteredHandleRead(...args) {
      const result = await handleRead.apply(this, args);
      count(result?.bytesRead, handlePaths.get(this));
      return result;
    };
  };
  const meteredOpen = fsp.open;
  fsp.open = async function meteredOpenFirst(...args) { const handle = await meteredOpen.apply(this, args); wrapHandle(handle); return handle; };
  syncBuiltinESMExports();

  const writer = setInterval(() => {
    const was = on;
    on = existsSync(flag);
    if (on && !was) { since = now(); total = 0; calls = 0; byReader = {}; byKind = {}; journals = {}; }
    if (!on && !was) return;
    const readers = Object.entries(byReader).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 80)
      .map(([who, r]) => ({ who, bytes: r.bytes, calls: r.calls, kinds: r.kinds }));
    const snapshot = { v: 1, on, since, at: now(), total, calls, byKind, readers, journals };
    try { mkdirSync(dirname(out), { recursive: true }); writeFileSync(`${out}.tmp`, JSON.stringify(snapshot)); renameSync(`${out}.tmp`, out); }
    catch (error) { console.error(`[read-meter] counts not written: ${error.message}`); }
  }, everyMs);
  writer.unref?.();
  return { stop: () => clearInterval(writer), count, totals: () => ({ total, calls }) };
}
