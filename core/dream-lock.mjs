import { join } from "node:path";
import { defaultWorkspace } from "./runtime-defaults.mjs";
import { acquireFileLease } from "./file-lease.mjs";
export { isPidAlive } from "./file-lease.mjs";

/** WHAT: Stores the existing controller lock. WHY: Prevents scheduled and manual Dream from dispatching concurrently. */
export function acquireDreamLock() {
  const lockPath = join(defaultWorkspace(process.env.HOME), ".dream.lock");
  const lease = acquireFileLease(lockPath);
  if (!lease) {
    console.log("Dream skipped: lock-held");
    return { acquired: false, release() {} };
  }
  return { acquired: true, release: lease.release };
}
