import { closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { defaultWorkspace } from "./runtime-defaults.mjs";

/** WHAT: Checks whether a pid answers signal 0. WHY: Keeps stale locks from suppressing future nights. */
export function isPidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

/** WHAT: Stores the existing controller lock. WHY: Prevents scheduled and manual Dream from dispatching concurrently. */
export function acquireDreamLock() {
  const lockPath = join(defaultWorkspace(process.env.HOME), ".dream.lock");
  mkdirSync(dirname(lockPath), { recursive: true });
  // flock locks the shared open-file description, retained by this process's
  // fd after the helper exits. Never unlink: kernel exit releases stale locks.
  const fd = openSync(lockPath, "a+", 0o600);
  const lock = spawnSync("flock", ["-n", "-E", "73", "3"], {
    stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8",
  });
  if (lock.error || (lock.status !== 0 && lock.status !== 73)) {
    closeSync(fd);
    throw new Error(`Dream lock unavailable: ${lock.error?.message || lock.stderr}`);
  }
  const old = readFileSync(lockPath, "utf8").trim();
  // Preserve an in-flight pre-upgrade controller. Its old PID-only lock is
  // never reaped while that process is live; new controllers use kernel locks.
  const legacyAlive = /^\d+\|/u.test(old) && isPidAlive(Number(old.split("|")[0]));
  if (lock.status === 73 || legacyAlive) {
    closeSync(fd);
    console.log("Dream skipped: lock-held");
    return { acquired: false, release() {} };
  }
  ftruncateSync(fd, 0);
  writeSync(fd, `kernel:${process.pid}|${new Date().toISOString()}`);
  let released = false;
  return { acquired: true, release() {
    if (released) return;
    released = true;
    try { ftruncateSync(fd, 0); } finally { closeSync(fd); }
  } };
}
