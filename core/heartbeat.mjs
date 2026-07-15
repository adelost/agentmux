// Bridge heartbeat: the liveness contract between the long-lived bridge
// process and everything that needs to know it is healthy (amux doctor,
// bin/bridge-watchdog-cron.sh). The supervisor (bin/start.sh) already
// restarts a CRASHED bridge; the heartbeat exists for the failure modes a
// supervisor cannot see:
//   - hung event loop (process alive, nothing being served)
//   - stale code (bridge started before the latest commit; nothing restarts
//     it, so fixes silently aren't live — the 1.20.32-35 trap)
//
// File: ~/.agentmux/bridge-heartbeat.json
//   { ts, pid, version, startedAt }

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export const HEARTBEAT_INTERVAL_MS = 30 * 1000;
// Watchdog/doctor consider the bridge hung past this. Generous vs the 30s
// interval: a busy event loop may delay a tick, a hung one misses many.
export const HEARTBEAT_STALE_MS = 5 * 60 * 1000;

export function heartbeatPath() {
  return process.env.AMUX_HEARTBEAT_PATH || join(homedir(), ".agentmux", "bridge-heartbeat.json");
}

export function writeHeartbeat({
  version,
  hintsVersion = null,
  startedAt,
  path = heartbeatPath(),
  now = new Date(),
}) {
  mkdirSync(dirname(path), { recursive: true });
  const beat = { ts: now.toISOString(), pid: process.pid, version, hintsVersion, startedAt };
  writeFileSync(path, JSON.stringify(beat) + "\n");
  return beat;
}

/** Parsed heartbeat or null (missing/corrupt file = no heartbeat). */
export function readHeartbeat(path = heartbeatPath()) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Classify a heartbeat against the current repo version:
 *   missing  - no file: bridge never ran with heartbeat support (or never ran)
 *   hung     - pid still alive but the beat is stale: event loop is stuck
 *   dead     - beat is stale and the pid is gone
 *   stale-code - beating fine but on an older version than the repo
 *   ok       - beating and current
 */
export function classifyHeartbeat(beat, { repoVersion, now = Date.now(), pidAlive }) {
  if (!beat) return { state: "missing" };
  const age = now - new Date(beat.ts || 0).getTime();
  const fresh = Number.isFinite(age) && age <= HEARTBEAT_STALE_MS;
  if (!fresh) return { state: pidAlive ? "hung" : "dead", ageMs: age };
  if (repoVersion && beat.version && beat.version !== repoVersion) {
    return { state: "stale-code", running: beat.version, repo: repoVersion };
  }
  return { state: "ok", ageMs: age };
}

/** Start the interval writer. Returns a stop function. */
export function startHeartbeat({
  version,
  hintsVersion = null,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  path = heartbeatPath(),
}) {
  const startedAt = new Date().toISOString();
  const tick = () => {
    try {
      writeHeartbeat({ version, hintsVersion, startedAt, path });
    } catch (err) {
      console.warn(`heartbeat write failed: ${err.message}`);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never keep the process alive just to beat
  return () => clearInterval(timer);
}
