import { FLEET_CODEX_MODEL, selectedCodexProfile, setCodexModelOverride } from "./codex-profiles.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { driveCodexStatus } from "./codex-status.mjs";
import { unparkPane } from "./pane-park.mjs";

/** WHAT: Builds an explicitly requested new fleet-model session on one idle pane. WHY: Keeps unavailable historical models from forcing paid compact retries or silent context replacement. */
export async function startFreshCodexSession({ agent, state, queue, name, pane, targetModel, targetEffort,
  statusDriver = driveCodexStatus, unpark = unparkPane }) {
  if (targetModel !== FLEET_CODEX_MODEL || targetEffort !== "xhigh") throw new Error("--new-session requires terra xhigh");
  const lease = queue.acquireSessionLease(name, pane);
  if (!lease) throw new Error("new session blocked: a delivery holds this session");
  try {
    if (queue.list(name, pane).some(job => !TERMINAL_DELIVERY_STATES.has(job.status))) throw new Error("new session blocked: this pane has queued deliveries");
    const process = await agent.paneProcessState(name, pane);
    if (process.running) throw new Error("new session requires a stopped pane; finish or checkpoint it and quit first");
    const profile = selectedCodexProfile(state, name, pane), key = `${name}:${pane}@${profile.id}`;
    const old = state.get("codex_session_by_pane_profile_v1", {})[key];
    await agent.ensureReady(name, pane, { profile, model: targetModel, effort: targetEffort, newSession: true });
    const verified = await statusDriver({ agent, name, pane });
    const native = verified.status;
    if (!verified.ok || native.model?.id !== targetModel || native.model?.effort !== targetEffort || !native.session
        || native.session === old?.sessionId) throw new Error("new session did not verify its model, effort and fresh identity");
    setCodexModelOverride(state, name, pane, targetModel, targetEffort);
    const sessions = state.get("codex_session_by_pane_profile_v1", {});
    state.set("codex_session_by_pane_profile_v1", { ...sessions, [key]: { ...sessions[key], pane: key, profileId: profile.id,
      sessionId: native.session, status: "ready", model: targetModel, effort: targetEffort,
      modelTransitionBlocked: null, supersededSessionId: old?.sessionId || sessions[key]?.supersededSessionId || null } });
    unpark({ session: name, pane, detail: `explicit verified new session ${native.session}` });
    return { model: targetModel, effort: targetEffort, sessionId: native.session };
  } finally { lease.release(); }
}
