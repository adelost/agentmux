// Persistent key-value state backed by a JSON file.
// Survives process restarts (unlike in-memory variables).
// Detects external file edits (e.g. `amux tts` from a different process)
// via a file stamp check — picks up the new value on the next get().
//
// The bridge and every amux CLI process share one file, so each write is a
// complete replacement (temp file, fsync, rename) under a cross-process lock
// that also re-reads the newest file. A reader never sees a half-written file,
// and two processes setting different keys never drop each other's key. A file
// that exists but does not parse is an error, never an empty state: treating
// it as {} once wiped every pane's account, model and session selection on the
// next set() (2026-10-10 12:46, a reader caught the 1 MB file mid-write).

import {
  closeSync, fchmodSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeSync,
} from "fs";
import { basename, dirname, join } from "path";
import { tryLockDir } from "./dir-lock.mjs";

const DEFAULT_MODE = 0o600;
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 12_000;
const LOCK_POLL_MS = 10;
const READ_ATTEMPTS = 5;
const READ_RETRY_MS = 20;

/** WHAT: Blocks the calling thread for a short pause. WHY: state get/set are synchronous for every caller. */
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** WHAT: Names a state file that exists but cannot be used. WHY: Stops callers from saving an empty state over it. */
export class StateFileError extends Error {
  constructor(path, cause) {
    super(`agentmux state file ${path} is unreadable or not a JSON object: ${cause?.message || cause}`);
    this.name = "StateFileError";
    this.path = path;
    this.cause = cause;
  }
}

const isJsonObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

const readStateOnce = (path) => {
  let text;
  try { text = readFileSync(path, "utf-8"); }
  catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!isJsonObject(parsed)) throw new SyntaxError("top level is not an object");
  return parsed;
};

/**
 * WHAT: Reads the state, retrying a file that is mid-write by an older non-atomic writer.
 * WHY: A torn read must never become {}; after the retries it fails loud.
 */
const loadState = (path, { readAttempts, readRetryMs, sleep }) => {
  for (let attempt = 1; ; attempt++) {
    try { return readStateOnce(path); }
    catch (error) {
      if (!(error instanceof SyntaxError) || attempt >= readAttempts) throw new StateFileError(path, error);
      sleep(readRetryMs);
    }
  }
};

const existingMode = (path) => {
  try { return statSync(path).mode & 0o777; } catch { return DEFAULT_MODE; }
};

/** WHAT: Replaces the state file in one rename. WHY: Readers see the old or the new file, never a truncated one. */
const writeStateAtomic = (path, data) => {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const mode = existingMode(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  const fd = openSync(temp, "wx", mode);
  try {
    fchmodSync(fd, mode);
    writeSync(fd, JSON.stringify(data, null, 2) + "\n");
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  closeSync(fd);
  try { renameSync(temp, path); }
  catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
};

/** WHAT: Identifies one version of the file. WHY: A rename changes the inode even when the mtime tick does not. */
const fileStamp = (path) => {
  try {
    const stat = statSync(path);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch { return null; }
};

/** WHAT: Runs one read-modify-write under the cross-process state lock. WHY: Two writers must not drop each other's keys. */
const withStateLock = (path, work, { lockStaleMs, lockTimeoutMs, sleep, now }) => {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = now() + lockTimeoutMs;
  let release = tryLockDir(lockPath, { staleMs: lockStaleMs });
  while (!release) {
    if (now() >= deadline) throw new Error(`agentmux state lock ${lockPath} stayed busy for ${lockTimeoutMs} ms`);
    sleep(LOCK_POLL_MS);
    release = tryLockDir(lockPath, { staleMs: lockStaleMs });
  }
  try { return work(); }
  finally { release(); }
};

// `path` is the JSON state file; the options are the time boundaries tests inject.
/**
 * WHAT: Builds a persistent key-value store on one JSON file shared by processes.
 * WHY: Keeps bridge and CLI processes from wiping each other's pane state.
 */
export const createState = (path, {
  sleep = sleepSync,
  now = Date.now,
  readAttempts = READ_ATTEMPTS,
  readRetryMs = READ_RETRY_MS,
  lockStaleMs = LOCK_STALE_MS,
  lockTimeoutMs = LOCK_TIMEOUT_MS,
} = {}) => {
  const readOptions = { readAttempts, readRetryMs, sleep };
  const lockOptions = { lockStaleMs, lockTimeoutMs, sleep, now };
  let data = loadState(path, readOptions);
  let lastStamp = fileStamp(path);

  // If the file was replaced or edited externally since our last read or
  // write, refresh the in-memory copy. This is what lets `amux tts` flip a
  // value and have a long-running bridge process notice on the next get().
  const maybeReload = () => {
    const stamp = fileStamp(path);
    if (stamp && stamp !== lastStamp) {
      data = loadState(path, readOptions);
      lastStamp = stamp;
    }
  };

  const update = (change) => withStateLock(path, () => {
    maybeReload(); // under the lock: the newest file, whoever wrote it
    const result = change(data);
    writeStateAtomic(path, data);
    lastStamp = fileStamp(path);
    return result;
  }, lockOptions);

  const get = (key, fallback = undefined) => {
    maybeReload();
    return key in data ? data[key] : fallback;
  };

  const set = (key, value) => update((current) => { current[key] = value; return value; });

  const toggle = (key) => update((current) => {
    current[key] = !(key in current ? current[key] : false);
    return current[key];
  });

  const remove = (key) => { update((current) => { delete current[key]; }); };

  const all = () => { maybeReload(); return { ...data }; };

  return { get, set, toggle, remove, all };
};
