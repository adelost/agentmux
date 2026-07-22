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
//   { ts, pid, version, sourceSha, startedAt }

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

/** WHAT: Stores one bridge heartbeat with exact code identity. WHY: Keeps liveness and release provenance observable outside the process. */
export function writeHeartbeat({
  version,
  sourceSha = null,
  hintsVersion = null,
  startedAt,
  path = heartbeatPath(),
  now = new Date(),
}) {
  mkdirSync(dirname(path), { recursive: true });
  const beat = { ts: now.toISOString(), pid: process.pid, version, sourceSha, hintsVersion, startedAt };
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

// States: missing, hung, dead, stale-code, or ok.
/** WHAT: Calculates bridge health from liveness and release identity. WHY: Prevents matching versions from hiding stale running code. */
export function classifyHeartbeat(beat, {
  repoVersion, repoSourceSha = null, now = Date.now(), pidAlive,
}) {
  if (!beat) return { state: "missing" };
  const age = now - new Date(beat.ts || 0).getTime();
  const fresh = Number.isFinite(age) && age <= HEARTBEAT_STALE_MS;
  if (pidAlive === false) return { state: "dead", ageMs: age };
  if (!fresh) return { state: pidAlive ? "hung" : "dead", ageMs: age };
  if (repoSourceSha && beat.sourceSha !== repoSourceSha) {
    return {
      state: "stale-code",
      runningSourceSha: beat.sourceSha || null,
      repoSourceSha,
    };
  }
  if (repoVersion && beat.version && beat.version !== repoVersion) {
    return { state: "stale-code", running: beat.version, repo: repoVersion };
  }
  return { state: "ok", ageMs: age };
}

/** Start the interval writer. Returns a stop function. */
/** WHAT: Schedules periodic bridge identity heartbeats. WHY: Keeps hung and stale processes visible without relying on their event loop output. */
export function startHeartbeat({
  version,
  sourceSha = null,
  hintsVersion = null,
  intervalMs = HEARTBEAT_INTERVAL_MS,
  path = heartbeatPath(),
}) {
  const startedAt = new Date().toISOString();
  const tick = () => {
    try {
      writeHeartbeat({ version, sourceSha, hintsVersion, startedAt, path });
    } catch (err) {
      console.warn(`heartbeat write failed: ${err.message}`);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // never keep the process alive just to beat
  return () => clearInterval(timer);
}
