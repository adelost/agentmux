// Durable observability for the in-process Claude quota-recovery loop.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue.mjs";

/** WHAT: Carries one recovery poll deadline. WHY: Prevents a wedged sidecar from waiting forever. */
export const QUOTA_RECOVERY_STALE_MS = 15 * 60 * 1_000;

/** WHAT: Resolves the durable beat path. WHY: Keeps every observer on one receipt. */
export function quotaRecoveryHeartbeatPath(env = process.env) {
  return env.AMUX_QUOTA_RECOVERY_HEARTBEAT_PATH
    || join(homedir(), ".agentmux", "quota-recovery-heartbeat.json");
}

/** WHAT: Stores recovery health atomically. WHY: Prevents observers from reading partial JSON. */
export function writeQuotaRecoveryHeartbeat(beat, {
  path = quotaRecoveryHeartbeatPath(),
  now = Date.now(),
} = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const value = { ...beat, ts: new Date(now).toISOString(), pid: process.pid };
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return value;
}

/** WHAT: Reads the last recovery beat. WHY: Keeps missing or corrupt state fail-visible. */
export function readQuotaRecoveryHeartbeat(path = quotaRecoveryHeartbeatPath()) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

/** WHAT: Builds heartbeat and continuation health. WHY: Keeps doctor observation bounded to one helper. */
export function quotaRecoveryHealthObservation(queue) {
  const pending = queue.allTargets()
    .flatMap(({ agentName, pane }) => queue.list(agentName, pane))
    .filter((job) => job.source === "quota-recovery"
      && !TERMINAL_DELIVERY_STATES.has(job.status)).length;
  return { beat: readQuotaRecoveryHeartbeat(), pending };
}
