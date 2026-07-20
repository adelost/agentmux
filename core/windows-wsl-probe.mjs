import { classifyHeartbeat } from "./heartbeat.mjs";
import { identityDecision } from "./release-identity.mjs";

/** WHAT: Builds a redacted WSL observation from local runtime facts. WHY: Keeps Windows status independent from shell text and process existence alone. */
export function buildWslObservation({
  bootId,
  heartbeat,
  pidAlive,
  identity,
  memoryState,
  memoryStale,
  nowMs = Date.now(),
} = {}) {
  const release = identityDecision(identity);
  const bridge = classifyHeartbeat(heartbeat, {
    repoVersion: identity?.packageVersion || null,
    repoSourceSha: identity?.sourceSha || null,
    now: nowMs,
    pidAlive: Boolean(pidAlive),
  });
  return {
    schemaVersion: 1,
    observedAt: new Date(nowMs).toISOString(),
    wslReachable: true,
    bootId: bootId || null,
    bridge,
    release: {
      ...release,
      sourceSha: identity?.sourceSha || null,
      packageVersion: identity?.packageVersion || null,
    },
    memory: {
      level: memoryState?.level || "unknown",
      stale: Boolean(memoryStale),
      observedAt: Number.isFinite(memoryState?.observedAt)
        ? new Date(memoryState.observedAt).toISOString()
        : null,
    },
  };
}
