// Timer ownership for Claude quota recovery, independent from auto-compact.

import {
  QUOTA_RECOVERY_STALE_MS,
  writeQuotaRecoveryHeartbeat,
} from "../core/quota-recovery-heartbeat.mjs";

const positiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * WHAT: Parses the quota recovery timer and kill switch.
 * WHY: Keeps deployment tuning outside the recovery state machine.
 */
export function parseQuotaRecoveryConfig(env = process.env) {
  return {
    enabled: env.AMUX_QUOTA_RECOVERY_ENABLED !== "false",
    pollMs: positiveInt(env.AMUX_QUOTA_RECOVERY_POLL_MS, 30_000),
    resetGraceMs: positiveInt(env.AMUX_QUOTA_RECOVERY_RESET_GRACE_MS, 15_000),
    stallMs: positiveInt(env.AMUX_QUOTA_RECOVERY_STALL_MS, QUOTA_RECOVERY_STALE_MS),
  };
}

/**
 * WHAT: Schedules one coalesced quota coordinator tick at a fixed cadence.
 * WHY: Keeps timer overlap and lifecycle ownership out of bridge startup code.
 */
export function createQuotaRecoveryLoop({
  coordinator,
  config = parseQuotaRecoveryConfig(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  heartbeat = (beat) => writeQuotaRecoveryHeartbeat(beat),
  onStall = (message) => {
    console.error(`quota-recovery | ${message}; restarting bridge`);
    process.exit(76);
  },
  log = (message) => console.log(`quota-recovery | ${message}`),
} = {}) {
  if (!coordinator) throw new Error("quota recovery loop requires coordinator");
  let intervalId = null;

  function beat(value) {
    try { heartbeat(value); }
    catch (error) { log(`heartbeat failed: ${error.message}`); }
  }

  async function tick() {
    const startedAt = Date.now();
    beat({ state: "running", startedAt: new Date(startedAt).toISOString() });
    let stallTimer = null;
    let didStall = false;
    const stalled = new Promise((resolve) => {
      stallTimer = setTimeoutImpl(() => {
        didStall = true;
        const message = `tick exceeded ${config.stallMs}ms`;
        beat({ state: "stalled", startedAt: new Date(startedAt).toISOString(), error: message });
        onStall(message);
        resolve([]);
      }, config.stallMs);
      stallTimer?.unref?.();
    });
    try {
      const results = await Promise.race([coordinator.tick(), stalled]);
      if (!didStall) beat({ state: "ok", targets: Array.isArray(results) ? results.length : 0 });
      return results;
    } catch (error) {
      log(`tick failed: ${error.message}`);
      beat({ state: "error", error: String(error.message || error).slice(0, 240) });
      return [];
    } finally {
      if (stallTimer) clearTimeoutImpl(stallTimer);
    }
  }

  function start() {
    if (!config.enabled || intervalId) return;
    intervalId = setIntervalImpl(() => { void tick(); }, config.pollMs);
    intervalId?.unref?.();
    void tick();
  }

  function stop() {
    if (intervalId) clearIntervalImpl(intervalId);
    intervalId = null;
  }

  return { start, stop, tick };
}
