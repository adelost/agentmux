// Exact-session wake lifecycle shared by the broker and `amux wake`.

import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import {
  blockedSleepState,
  paneSleepStateDir,
  readPaneSleepState,
  sleepingWakeDecision,
  writePaneSleepState,
} from "./pane-sleep.mjs";

/** WHAT: Builds the broker-facing sleep wake lifecycle. WHY: Keeps durable session proof separate from composer delivery. */
export function createPaneSleepWakeLifecycle({
  resolvePane,
  stateRoot = paneSleepStateDir(),
  now = () => Date.now(),
} = {}) {
  if (typeof resolvePane !== "function") throw new Error("pane sleep wake lifecycle requires resolvePane");
  const stateOptions = { rootDir: stateRoot };

  async function prepare({ agentName, pane }) {
    let state = readPaneSleepState(agentName, pane, stateOptions);
    if (!state || state.status === "awake") return { ok: true, tracked: false };
    const target = resolvePane(agentName, pane);
    if (!target?.paneDir || target.engine !== "claude") {
      return { ok: false, reason: "sleep-target-unresolvable" };
    }
    const identity = latestClaudeSessionIdentity(target.paneDir);
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
