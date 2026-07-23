// Exact-session wake lifecycle shared by the broker and `amux wake`.

import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import {
  blockedSleepState,
  paneSleepStateDir,
  readPaneSleepState,
  sleepingWakeDecision,
  writePaneSleepState,
} from "./pane-sleep.mjs";
import {
  blockedWakeDecision,
  planSleepRepair,
  PANE_SLEEP_REPAIR_TTL_MS,
  sleepProcessTruth,
} from "./pane-sleep-repair.mjs";

/** WHAT: Builds the broker-facing sleep wake lifecycle. WHY: Keeps durable session proof separate from composer delivery. */
export function createPaneSleepWakeLifecycle({
  resolvePane,
  processState = null,
  stateRoot = paneSleepStateDir(),
  now = () => Date.now(),
  repairTtlMs = PANE_SLEEP_REPAIR_TTL_MS,
} = {}) {
  if (typeof resolvePane !== "function") throw new Error("pane sleep wake lifecycle requires resolvePane");
  const stateOptions = { rootDir: stateRoot };

  async function interruptedTruth(agentName, pane, identity) {
    const probe = typeof processState === "function"
      ? await Promise.resolve().then(() => processState(agentName, pane)).catch(() => null)
      : null;
    return sleepProcessTruth(probe, identity);
  }

  async function prepare({ agentName, pane }) {
    let state = readPaneSleepState(agentName, pane, stateOptions);
    if (!state || state.status === "awake") return { ok: true, tracked: false };
    const target = resolvePane(agentName, pane);
    if (!target?.paneDir || target.engine !== "claude") {
      return { ok: false, reason: "sleep-target-unresolvable" };
    }
    const identity = latestClaudeSessionIdentity(target.paneDir);
    if (state.status === "blocked") {
      // A classified failure used to refuse every later wake forever. The
      // retry re-proves process truth; anything unclear still fails closed.
      const verdict = blockedWakeDecision({
        state,
        truth: await interruptedTruth(agentName, pane, identity),
      });
      if (!verdict.ok) return { ok: false, reason: verdict.reason };
      const repaired = {
        ...state,
        repairedFrom: "blocked",
        repairedAt: now(),
        updatedAt: now(),
      };
      if (verdict.action === "clear") {
        writePaneSleepState({ ...repaired, status: "awake", stage: "awake" }, stateOptions);
        return { ok: true, tracked: false };
      }
      // The recorded session is provably stopped; it re-enters the normal
      // asleep path and must pass the exact-session decision below.
      state = writePaneSleepState({ ...repaired, status: "asleep", stage: "asleep" }, stateOptions);
    } else if (state.status === "arming") {
      const plan = planSleepRepair({
        state,
        truth: await interruptedTruth(agentName, pane, identity),
        nowMs: now(),
        ttlMs: repairTtlMs,
      });
      if (plan.action === "hold") {
        writePaneSleepState(blockedSleepState(state, `sleep-state-${state.status}`, now()), stateOptions);
        return { ok: false, reason: `sleep-state-${state.status}` };
      }
      state = writePaneSleepState(plan.state, stateOptions);
      if (state.status === "awake") return { ok: true, tracked: false };
    }
    const decision = sleepingWakeDecision({ state, sessionId: identity?.sessionId || null });
    if (!decision.ok) {
      writePaneSleepState(blockedSleepState(state, decision.reason, now()), stateOptions);
      return { ok: false, reason: decision.reason };
    }
    state = writePaneSleepState({
      ...state,
      status: "wake_pending",
      stage: "wake-intent",
      wakeRequestedAt: state.wakeRequestedAt || now(),
      updatedAt: now(),
    }, stateOptions);
    return {
      ok: true,
      tracked: true,
      sessionId: state.sessionId,
      sleepGeneration: state.sleepGeneration,
    };
  }

  async function complete({ agentName, pane, token, processState }) {
    if (!token?.tracked) return { ok: true, tracked: false };
    const state = readPaneSleepState(agentName, pane, stateOptions);
    const target = resolvePane(agentName, pane);
    const identity = target?.paneDir ? latestClaudeSessionIdentity(target.paneDir) : null;
    if (state?.status !== "wake_pending"
        || state.sleepGeneration !== token.sleepGeneration
        || state.sessionId !== token.sessionId
        || identity?.sessionId !== token.sessionId
        || processState?.running !== true) {
      if (state) {
        writePaneSleepState(blockedSleepState(state, "wake-verification-failed", now()), stateOptions);
      }
      return { ok: false, reason: "wake-verification-failed" };
    }
    writePaneSleepState({
      ...state,
      status: "awake",
      stage: "awake",
      wokeAt: now(),
      updatedAt: now(),
    }, stateOptions);
    return { ok: true, tracked: true };
  }

  return { prepare, complete };
}
