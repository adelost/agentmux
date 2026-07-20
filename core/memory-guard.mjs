// Memory admission guard: one small state machine that keeps the host from
// sleepwalking into the 2026-07-20 WSL OOM (48 GiB + 4 GiB swap exhausted).
//
//   observeMemory(meminfo) -> classify(normal|warn|blocked|critical)
//   transitionGuard(...)   -> hysteresis (2x critical to escalate, 3x clear to recover)
//   canStartHeavy(...)     -> admission for automatic heavy starters
//
// The guard never kills and never restarts anything. It only: (a) classifies
// memory pressure into a durable state file, (b) alarms on level transitions
// and recovery, (c) answers canStartHeavy for automatic heavy starters
// (fail-closed when the state is missing, stale, or from another boot).

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** WHAT: Defines relative memory thresholds for a 48 GiB host. WHY: Keeps guard tuning separate from decision logic. */
export const MEMORY_GUARDRAIL_DEFAULTS = Object.freeze({
  warnAvailableRatio: 0.17,
  blockAvailableRatio: 0.11,
  blockSwapFreeRatio: 0.25,
  criticalAvailableRatio: 0.06,
  criticalSwapFreeRatio: 0.10,
  clearAvailableRatio: 0.21,
  criticalSamples: 2,
  clearSamples: 3,
  stateTtlMs: 75_000, // > 2 poll intervals at the 30 s default cadence
});

const LEVELS = ["normal", "warn", "blocked", "critical"];
const HEAVY_CLASSES = new Set(["browser", "emulator", "heavy-gate", "pane-revive"]);

/** WHAT: Parses /proc/meminfo into the four counters the guard uses. WHY: Prevents mixed-snapshot decisions from skewing thresholds. */
export function parseMeminfo(text) {
  const read = (key) => {
    const match = String(text).match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, "mu"));
    return match ? Number(match[1]) : null;
  };
  const sample = {
    memTotalKb: read("MemTotal"),
    memAvailableKb: read("MemAvailable"),
    swapTotalKb: read("SwapTotal"),
    swapFreeKb: read("SwapFree"),
  };
  if (!sample.memTotalKb || sample.memAvailableKb === null) {
    throw new Error("meminfo snapshot is missing MemTotal/MemAvailable");
  }
  return sample;
}

function ratios(sample) {
  return {
    available: sample.memAvailableKb / sample.memTotalKb,
    swapFree: sample.swapTotalKb > 0 ? sample.swapFreeKb / sample.swapTotalKb : 1,
  };
}

/** WHAT: Maps one memory snapshot to a pressure level. WHY: Prevents callers from re-implementing threshold rules. */
export function classifyMemory(sample, t = MEMORY_GUARDRAIL_DEFAULTS) {
  const { available, swapFree } = ratios(sample);
  if (available < t.criticalAvailableRatio && swapFree < t.criticalSwapFreeRatio) return "critical";
  if (available < t.blockAvailableRatio) return "blocked";
  if (available < t.warnAvailableRatio && swapFree < t.blockSwapFreeRatio) return "blocked";
  if (available < t.warnAvailableRatio) return "warn";
  return "normal";
}

/** WHAT: Turns each sample into a hysteresis-filtered guard level. WHY: Prevents flapping from dropping protection during brief dips. */
export function transitionGuard(prev, sample, t = MEMORY_GUARDRAIL_DEFAULTS) {
  const cls = classifyMemory(sample, t);
  const { available } = ratios(sample);
  const level = prev?.level || "normal";
  const critStreak = cls === "critical" ? (prev?.critStreak || 0) + 1 : 0;
  const clearStreak = available > t.clearAvailableRatio ? (prev?.clearStreak || 0) + 1 : 0;
  let next = level;
  if (cls === "critical") {
    if (critStreak >= t.criticalSamples) next = "critical";
    else if (LEVELS.indexOf(level) < LEVELS.indexOf("blocked")) next = "blocked";
  } else if (LEVELS.indexOf(cls) > LEVELS.indexOf(level)) {
    next = cls;
  }
  if (clearStreak >= t.clearSamples) next = "normal";
  return { level: next, critStreak, clearStreak, classified: cls };
}

/** WHAT: Resolves the durable guard state path. WHY: Keeps state location separate from guard logic. */
export function memoryGuardStatePath() {
  return process.env.AMUX_MEMORY_GUARD_PATH
    || join(homedir(), ".agentmux", "memory-guard.json");
}

function currentBootId(readFile = (p) => readFileSync(p, "utf8")) {
  try { return readFile("/proc/sys/kernel/random/boot_id").trim(); }
  catch { return null; }
}

/** WHAT: Stores the guard state atomically with boot identity. WHY: Prevents consumers from acting on a dead boot's verdict. */
export function writeGuardState(state, { path = memoryGuardStatePath() } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return state;
}

/** WHAT: Reads the persisted guard state. WHY: Separates corrupt state from a valid verdict. */
export function readGuardState({ path = memoryGuardStatePath() } = {}) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

/** WHAT: Checks whether a persisted state is usable right now. WHY: Prevents a stale or foreign-boot guard from proving safety. */
export function isGuardStateStale(state, {
  nowMs = Date.now(),
  bootId = currentBootId(),
  ttlMs = MEMORY_GUARDRAIL_DEFAULTS.stateTtlMs,
} = {}) {
  if (!state || !Number.isFinite(state.observedAt)) return true;
  if (state.observedAt > nowMs) return true;
  if (bootId && state.bootId !== bootId) return true;
  return nowMs - state.observedAt > ttlMs;
}

/** WHAT: Checks admission for one automatic heavy start. WHY: Prevents automatic heavy jobs from launching into memory pressure. */
export function canStartHeavy(state, {
  class: heavyClass,
  reserveMiB = 0,
  automatic = true,
  nowMs = Date.now(),
  bootId = currentBootId(),
  ttlMs = MEMORY_GUARDRAIL_DEFAULTS.stateTtlMs,
  t = MEMORY_GUARDRAIL_DEFAULTS,
} = {}) {
  if (!HEAVY_CLASSES.has(heavyClass)) {
    return { ok: false, reason: `unknown-heavy-class:${String(heavyClass)}` };
  }
  if (!automatic) return { ok: true, reason: "manual-override" };
  if (isGuardStateStale(state, { nowMs, bootId, ttlMs })) {
    return { ok: false, reason: "guard-state-stale" };
  }
  if (state.level === "blocked" || state.level === "critical") {
    return { ok: false, reason: `memory-${state.level}` };
  }
  if (reserveMiB > 0 && state.sample?.memAvailableKb && state.sample?.memTotalKb) {
    const projectedMiB = (state.sample.memAvailableKb - reserveMiB * 1024) / 1024;
    const floorMiB = (t.blockAvailableRatio * state.sample.memTotalKb) / 1024;
    if (projectedMiB < floorMiB) {
      return { ok: false, reason: "memory-reserve-floor" };
    }
  }
  return { ok: true, reason: state.level === "warn" ? "memory-warn-allowed" : "ok" };
}

/** WHAT: Tracks one guard poll: sample, transition, persist. WHY: Keeps the writer path identical from bridge to tests. */
export function pollMemoryGuardOnce({
  path = memoryGuardStatePath(),
  readMeminfo = () => readFileSync("/proc/meminfo", "utf8"),
  bootId = currentBootId(),
  nowMs = Date.now(),
  t = MEMORY_GUARDRAIL_DEFAULTS,
} = {}) {
  const sample = parseMeminfo(readMeminfo());
  const prev = readGuardState({ path });
  const transitioned = transitionGuard(prev, sample, t);
  const state = {
    schemaVersion: 1,
    bootId,
    observedAt: nowMs,
    level: transitioned.level,
    critStreak: transitioned.critStreak,
    clearStreak: transitioned.clearStreak,
    classified: transitioned.classified,
    sample,
  };
  writeGuardState(state, { path });
  return { state, previousLevel: prev?.level || null, changed: prev?.level !== state.level };
}

/** WHAT: Schedules the guard and alarms on transitions only. WHY: Keeps alarms as events, separate from a polling drip. */
export function startMemoryGuard({
  intervalMs = 30_000,
  onTransition = () => {},
  log = (message) => console.warn(message),
  ...pollOptions
} = {}) {
  const tick = () => {
    try {
      const { state, previousLevel, changed } = pollMemoryGuardOnce(pollOptions);
      // A first-ever non-normal verdict is one visible alert, not a silent
      // boot; the next poll carries previousLevel and stays quiet again.
      const initialAlert = !previousLevel && state.level !== "normal";
      if ((changed && previousLevel) || initialAlert) {
        Promise.resolve(onTransition({ from: previousLevel, to: state.level, state }))
          .catch((error) => log(`memory-guard alarm failed: ${error.message}`));
      }
    } catch (error) {
      log(`memory-guard poll failed: ${error.message}`);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
