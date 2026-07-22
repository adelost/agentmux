// Recovery for interrupted pane sleep records.
//
// A bridge stop between arming and asleep, or between wake prepare and
// complete, parked the pane until its state file was removed by hand. This
// module re-judges stale records against live process and session truth. It
// never stops or starts a process; unclear evidence stays parked.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import {
  PANE_SLEEP_STATES,
  PANE_SLEEP_VERSION,
  paneSleepStateDir,
  readPaneSleepState,
  writePaneSleepState,
} from "./pane-sleep.mjs";

/** WHAT: Defines the stale-record re-examination age. WHY: Keeps in-flight sleep transitions safe from premature repair. */
export const PANE_SLEEP_REPAIR_TTL_MS = 15 * 60 * 1000;

const REPAIRABLE_STATUSES = new Set(["arming", "wake_pending"]);

function exactSession(recorded, latest) {
  return typeof recorded === "string" && recorded.length > 0 && recorded === latest;
}

function truthKnown(truth) {
  return Boolean(truth) && (truth.running === true || truth.running === false);
}

/** WHAT: Normalizes one process probe and session identity into wake truth. WHY: Keeps ambiguous snapshots fail-closed across every caller. */
export function sleepProcessTruth(probe, identity) {
  return {
    running: probe && (probe.running === true || probe.running === false) ? probe.running : null,
    sessionId: identity?.sessionId || null,
  };
}

/** WHAT: Maps one interrupted record and its process truth to a repair action. WHY: Keeps crashed sleep or wake attempts from parking a pane forever. */
export function planSleepRepair({ state, truth, nowMs, ttlMs = PANE_SLEEP_REPAIR_TTL_MS } = {}) {
  if (!state || !REPAIRABLE_STATUSES.has(state.status)) {
    return { action: "hold", reason: "repair-not-applicable" };
  }
  const ageMs = Number(nowMs) - Number(state.updatedAt ?? state.armedAt ?? NaN);
  if (!Number.isFinite(ageMs) || ageMs < Number(ttlMs)) {
    return { action: "hold", reason: "repair-ttl-not-met" };
  }
  if (!truthKnown(truth)) return { action: "hold", reason: "repair-truth-unknown" };
  const repaired = {
    ...state,
    repairedFrom: state.status,
    repairedAt: Number(nowMs),
    updatedAt: Number(nowMs),
  };
  // A provably running pane is awake regardless of which session it runs;
  // the interrupted attempt is over and no wake is needed.
  if (truth.running === true) {
    return {
      action: "clear",
      reason: "repair-process-running",
      state: { ...repaired, status: "awake", stage: "awake" },
    };
  }
  // A stopped pane may only become asleep when its exact recorded session is
  // still the latest on disk; anything else stays parked for an operator.
  if (!exactSession(state.sessionId, truth.sessionId)) {
    return { action: "hold", reason: "repair-session-mismatch" };
  }
  return {
    action: "asleep",
    reason: "repair-process-exited",
    state: { ...repaired, status: "asleep", stage: "asleep", sleptAt: Number(nowMs) },
  };
}

/** WHAT: Checks one blocked record against live truth for a forced wake. WHY: Keeps a classified failure recoverable without trusting the request blindly. */
export function blockedWakeDecision({ state, truth } = {}) {
  if (!state || state.status !== "blocked") return { ok: false, reason: "sleep-state-not-blocked" };
  if (!truthKnown(truth)) return { ok: false, reason: "sleep-state-blocked" };
  if (truth.running === true) {
    return { ok: true, tracked: false, action: "clear", reason: "blocked-truth-awake" };
  }
  if (!exactSession(state.sessionId, truth.sessionId)) {
    return { ok: false, reason: "sleep-session-mismatch" };
  }
  return { ok: true, tracked: true, action: "wake", reason: "blocked-truth-asleep" };
}

/** WHAT: Reads every valid durable sleep record under one state root. WHY: Keeps malformed files out of the boot-time repair pass. */
export function listPaneSleepStates({
  rootDir = paneSleepStateDir(),
  list = (dir) => readdirSync(dir),
  readFile = (path) => readFileSync(path, "utf8"),
} = {}) {
  let names;
  try {
    names = list(rootDir);
  } catch {
    return [];
  }
  const states = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let value;
    try {
      value = JSON.parse(readFile(join(rootDir, name)));
    } catch {
      continue;
    }
    if (value?.version !== PANE_SLEEP_VERSION
        || typeof value?.agentName !== "string"
        || !Number.isSafeInteger(value?.pane)
        || !PANE_SLEEP_STATES.has(value?.status)
        || !Number.isSafeInteger(value?.sleepGeneration)
        || value.sleepGeneration < 0) continue;
    states.push(value);
  }
  return states;
}

/** WHAT: Builds the truth-checking repair pass over durable sleep records. WHY: Keeps recovery on the same process and session proof as a normal wake. */
export function createPaneSleepRepair({
  resolvePane,
  processState,
  stateRoot = paneSleepStateDir(),
  now = () => Date.now(),
  ttlMs = PANE_SLEEP_REPAIR_TTL_MS,
  latestIdentity = latestClaudeSessionIdentity,
} = {}) {
  if (typeof resolvePane !== "function") throw new Error("pane sleep repair requires resolvePane");
  const stateOptions = { rootDir: stateRoot };

  async function truthFor(agentName, pane) {
    const target = resolvePane(agentName, pane);
    if (!target?.paneDir || target.engine !== "claude") return null;
    const probe = typeof processState === "function"
      ? await Promise.resolve().then(() => processState(agentName, pane)).catch(() => null)
      : null;
    if (!probe || (probe.running !== true && probe.running !== false)) return null;
    return {
      running: probe.running,
      sessionId: latestIdentity(target.paneDir)?.sessionId || null,
    };
  }

  async function repairState(state) {
    const plan = planSleepRepair({
      state,
      truth: await truthFor(state.agentName, state.pane),
      nowMs: now(),
      ttlMs,
    });
    if (plan.action === "hold") return { ...plan, state };
    return { ...plan, state: writePaneSleepState(plan.state, stateOptions) };
  }

  async function repairPane({ agentName, pane }) {
    const state = readPaneSleepState(agentName, pane, stateOptions);
    if (!state) return { action: "hold", reason: "repair-not-applicable", state: null };
    return repairState(state);
  }

  async function sweep() {
    const results = [];
    for (const state of listPaneSleepStates({ rootDir: stateRoot })) {
      results.push(await repairState(state));
    }
    return results;
  }

  return { repairPane, sweep };
}
