// Timer ownership for Claude quota recovery, independent from auto-compact.

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
  log = (message) => console.log(`quota-recovery | ${message}`),
} = {}) {
  if (!coordinator) throw new Error("quota recovery loop requires coordinator");
  let intervalId = null;

  function tick() {
    return coordinator.tick().catch((error) => {
      log(`tick failed: ${error.message}`);
      return [];
    });
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
