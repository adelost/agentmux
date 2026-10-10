// Cross-process locks in the format proper-lockfile uses, so amux and Claude
// Code see each other's locks. A lock is an empty directory. Its holder keeps
// the mtime fresh, so a lock older than the stale window belongs to a dead
// holder and may be taken over.

import { mkdirSync, rmdirSync, statSync } from "node:fs";

const isStale = (path, staleMs, now, fs) => {
  try { return now() - fs.statSync(path).mtimeMs > staleMs; }
  catch { return false; }
};

// Returns a release function, or null while another live holder has it. `now` must be
// the wall clock: it is compared with the lock directory's real mtime.
/**
 * WHAT: Returns one directory lock without waiting.
 * WHY: Keeps two processes from using one refresh token or usage budget at once.
 */
export function tryLockDir(path, {
  staleMs,
  now = Date.now,
  fs = { mkdirSync, rmdirSync, statSync },
} = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.mkdirSync(path);
      return () => { try { fs.rmdirSync(path); } catch {} };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (attempt > 0 || !isStale(path, staleMs, now, fs)) return null;
      try { fs.rmdirSync(path); } catch { return null; }
    }
  }
  return null;
}
