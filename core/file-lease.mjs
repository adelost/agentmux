import { closeSync, constants, fstatSync, ftruncateSync, mkdirSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";

/** WHAT: Checks a legacy process owner. WHY: Prevents upgrades from overtaking a live PID-only lease. */
export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function legacyOwner(raw) {
  if (/^\d+\|/u.test(raw)) return Number(raw.split("|")[0]);
  if (!raw.startsWith("{")) return null;
  try { const value = JSON.parse(raw); return value.kind === "kernel-lease" ? null : Number(value.pid); }
  catch { return null; }
}

/** WHAT: Returns a kernel-backed local file lease. WHY: Prevents stale reapers from unlinking a new live owner's inode. */
export function acquireFileLease(path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let owned = false;
  try {
    const inode = fstatSync(fd);
    if (!inode.isFile()) throw new Error(`lease is not a regular file: ${path}`);
    // The helper and this parent share the open-file description. The parent
    // retains the kernel lock after the helper exits; process death releases it.
    const lock = spawnSync("flock", ["-n", "-E", "73", "3"], {
      stdio: ["ignore", "pipe", "pipe", fd], encoding: "utf8", timeout: 2_000,
    });
    if (lock.error || ![0, 73].includes(lock.status)) {
      throw new Error(`file lease requires flock: ${lock.error?.message || lock.stderr || lock.status}`);
    }
    if (lock.status === 73) return null;
    const named = statSync(path);
    if (named.ino !== inode.ino || named.dev !== inode.dev) throw new Error(`lease inode changed: ${path}`);
    const raw = readFileSync(fd, "utf8").trim();
    if (isPidAlive(legacyOwner(raw))) return null;
    ftruncateSync(fd, 0);
    writeSync(fd, JSON.stringify({ kind: "kernel-lease", pid: process.pid }), 0);
    owned = true;
    let released = false;
    return { release() {
      if (released) return;
      released = true;
      try { ftruncateSync(fd, 0); } finally { closeSync(fd); }
    } };
  } finally {
    if (!owned) closeSync(fd);
  }
}
