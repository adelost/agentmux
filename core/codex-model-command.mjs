import { prepareCodexIdle } from "./codex-tui.mjs";
import {
  clearCodexModelOverride,
  codexModelCatalog,
  codexModelOverride,
  resolveCatalogCodexModel,
  selectedCodexProfile,
  setCodexModelOverride,
} from "./codex-profiles.mjs";
import { compactThenSwitchCodex } from "./codex-model-switch.mjs";
import { sendSlashVerified } from "./delivery.mjs";
import { parseCodexPaneReading } from "./codex-status.mjs";
import { contextMaintenanceAttempt } from "./context-maintenance.mjs";
import { validCodexCompactReceipt } from "./codex-launch-policy.mjs";

// Plain words first, the technical code last (Mattias 2026-10-02: "UX:en här
// är ju sjukt dålig. Jag fattar verkligen inte vad som händer.").
/** WHAT: Reports the verified model action. WHY: Prevents a no-op or reused receipt from claiming another paid compact. */
export function formatCodexModelChange(name, pane, result) {
  const selected = `${result.model}${result.effort ? ` ${result.effort}` : ""}`;
  if (result.unchanged) return `${name}:${pane} already runs ${selected}. Nothing changed.`;
  const compact = result.reusedCompact ? "No compact was needed" : "The context was compacted first";
  return `${name}:${pane} now runs ${selected}. ${compact}; other panes are unchanged.`;
}

/** WHAT: Reports why a model change stopped and what waits on it. WHY: Keeps a failed switch from looking like a changed model. */
export function formatCodexModelFailure(name, pane, result) {
  const code = result.reason || result.error || result.stage;
  // A failed compact or switch blocks new work until a switch succeeds.
  const held = ["compact", "delivery", "switch"].includes(result.stage)
    ? ` Messages to ${name}:${pane} wait until a switch succeeds; send /model again to retry.` : "";
  if (result.stage === "switch" && result.rollbackError) {
    return `${name}:${pane} may be stopped. The new model did not start (${result.error}), and restoring the previous model failed (${result.rollbackError}).${held}`;
  }
  const why = result.stage === "lease" ? "Another delivery kept this session busy for 6 minutes."
    : result.stage === "switch" ? `The new model did not start (${result.error}), so the previous model is back.`
      : ["compact", "delivery"].includes(result.stage) ? `The compact that has to run first did not finish (${code}).`
        : `${result.error || code}.`;
  return `${name}:${pane} was not switched. ${why}${held}`;
}

/** WHAT: Resolves one pane's model request and its first reply. WHY: Keeps a name the account cannot run from reaching compact or restart. */
export function codexModelRequest({ state, name, pane, requested, models = codexModelCatalog }) {
  const resolved = resolveCatalogCodexModel(requested, models(selectedCodexProfile(state, name, pane)));
  if (!resolved.ok) return { ...resolved, reply: `⚠️ ${resolved.reason}. ${name}:${pane} keeps its current model.` };
  const match = resolved.requested ? ` (the only ${resolved.requested} model)` : "";
  return { ...resolved, reply: `🔄 Switching ${name}:${pane} to ${resolved.model}${match}. This takes seconds, or minutes if a compact has to run first.` };
}

/** WHAT: Returns a shared session lease after bounded waiting. WHY: Prevents unrelated pane maintenance from rejecting an explicit model choice immediately. */
export async function waitForCodexModelLease(queue, name, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 360 } = {}) {
  if (!queue) return null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const lease = queue.acquireSessionLease(name);
    if (lease) return lease;
    if (attempt + 1 < attempts) await wait(1_000);
  }
  return null;
}

/** WHAT: Routes a model change under the session's physical lease. WHY: Prevents a compact from queueing behind the very broker lock that awaits it. */
export async function runLockedCodexModelChange({ deliveryBroker, ...options }) {
  const queue = deliveryBroker?.queue;
  const lease = await waitForCodexModelLease(queue, options.name, { wait: options.wait });
  if (queue && !lease) return { ok: false, stage: "lease", reason: "delivery-lease-busy" };
  try {
    if (options.agent.paneProcessState && !(await options.agent.paneProcessState(options.name, options.pane)).running) {
      const prior = await contextReader(options.agent, options.name, options.pane)();
      await options.agent.ensureReady(options.name, options.pane, {
        profile: selectedCodexProfile(options.state, options.name, options.pane),
        model: prior?.model || options.targetModel, effort: prior?.effort || options.targetEffort,
        retryModelChange: true,
      });
    }
    const result = await runCompactFirstCodexModelChange({ ...options,
      sendCompact: () => sendSlashVerified(options.agent, options.name, options.pane, "/compact", { settleMs: 200, maxRescues: 0 }),
    });
    if (!result.ok && ["compact", "delivery", "switch"].includes(result.stage)) blockModelChange(options, result);
    return result;
  } catch (error) {
    const result = { ok: false, stage: "compact", error: error.message };
    blockModelChange(options, result);
    return result;
  } finally { lease?.release(); }
}

function blockModelChange({ state, name, pane, targetModel, targetEffort }, result) {
  const key = `${name}:${pane}@${selectedCodexProfile(state, name, pane).id}`;
  const sessions = state.get("codex_session_by_pane_profile_v1", {});
  state.set("codex_session_by_pane_profile_v1", { ...sessions, [key]: { ...sessions[key],
    modelTransitionBlocked: { target: targetModel, reason: result.error || result.reason || result.stage } } });
  setCodexModelOverride(state, name, pane, targetModel, targetEffort || null);
}

const contextReader = (agent, name, pane) => () =>
  agent.getContext?.(name, pane) ?? agent.getContextPercent(name, pane);

async function rollbackLaunch({ agent, state, name, pane, profile, previous }) {
  const idle = await prepareCodexIdle({ agent, name, pane });
  if (!idle.ok) throw new Error(`blocked to preserve pane input (${idle.stage}: ${idle.error})`);
  if (previous?.model) setCodexModelOverride(state, name, pane, previous.model, previous.effort);
  else clearCodexModelOverride(state, name, pane);
  await agent.restartCodex(name, pane, {
    profile,
    model: previous?.model || null,
    effort: previous?.effort || null,
  });
}

/** WHAT: Routes one pane-local Codex change through verified compact. WHY: Prevents old context crossing models without a compact receipt. */
export async function runCompactFirstCodexModelChange({
  agent,
  state,
  name,
  pane,
  targetModel,
  targetEffort,
  sendCompact,
  statusDriver,
  log = () => {},
  wait,
  now,
  timeoutMs,
  pollMs,
}) {
  const readContext = contextReader(agent, name, pane);
  const initialIdle = await prepareCodexIdle({ agent, name, pane });
  if (!initialIdle.ok) return { ok: false, stage: initialIdle.stage, error: initialIdle.error };

  const live = parseCodexPaneReading(initialIdle.snapshot)?.selected;
  const matches = model => model?.id === targetModel && (!targetEffort || model.effort === targetEffort.toLowerCase());
  if (matches(live && { id: live.model, effort: live.effort })) {
    const verified = await statusDriver({ agent, name, pane, log });
    if (!verified.ok) return verified;
    if (!matches(verified.status.model)) return { ok: false, stage: "status", error: "live model changed during verification" };
    const actual = verified.status.model;
    setCodexModelOverride(state, name, pane, actual.id, actual.effort);
    const key = `${name}:${pane}@${selectedCodexProfile(state, name, pane).id}`;
    const sessions = state.get("codex_session_by_pane_profile_v1", {});
    if (sessions[key]?.sessionId === verified.status.session) state.set("codex_session_by_pane_profile_v1",
      { ...sessions, [key]: { ...sessions[key], model: actual.id, effort: actual.effort, modelTransitionBlocked: null } });
    return { ok: true, unchanged: true, model: actual.id, effort: actual.effort, status: verified.status };
  }

  let reusedCompact = false;
  const compact = agent.compactCodex ? async () => {
    const context = await readContext();
    const prior = context?.sessionId ? contextMaintenanceAttempt(state, name, pane, context) : null;
    const receipt = prior?.status === "VERIFIED" ? { ...prior, ok: true, compactBoundary: true } : null;
    if (validCodexCompactReceipt(receipt, context?.sessionId)) { reusedCompact = true; return receipt; }
    return agent.compactCodex(name, pane, { sendCompact });
  } : null;

  const result = await compactThenSwitchCodex({
    readContext,
    readOutput: () => agent.capturePane(name, pane),
    sendCompact,
    compact,
    wait,
    now,
    timeoutMs,
    pollMs,
    switchModel: async ({ beforeContext, compactReceipt }) => {
      const idle = await prepareCodexIdle({ agent, name, pane });
      if (!idle.ok) return { ok: false, stage: idle.stage, error: idle.error };
      const previous = live || (beforeContext?.model ? { model: beforeContext.model, effort: beforeContext.effort ?? null }
        : codexModelOverride(state, name, pane));
      const effort = targetEffort?.toLowerCase() || previous?.effort || null;
      const profile = selectedCodexProfile(state, name, pane);
      setCodexModelOverride(state, name, pane, targetModel, effort);
      try {
        if (previous?.model !== targetModel || (effort && previous?.effort !== effort)) {
          await agent.restartCodex(name, pane, { profile, model: targetModel, effort, compactReceipt, retryModelChange: true });
        }
        const verified = await statusDriver({ agent, name, pane, log });
        if (!verified.ok) throw new Error(`native status: ${verified.stage}: ${verified.error}`);
        const actual = verified.status.model;
        if (actual?.id !== targetModel || (effort && actual?.effort !== effort)) {
          throw new Error(`expected ${targetModel}${effort ? ` ${effort}` : ""}, status shows ${actual?.id || "unknown"}${actual?.effort ? ` ${actual.effort}` : ""}`);
        }
        return { model: actual.id, effort: actual.effort, status: verified.status };
      } catch (error) {
        let rollbackError = null;
        try { await rollbackLaunch({ agent, state, name, pane, profile, previous }); }
        catch (rollback) { rollbackError = rollback.message; }
        return { ok: false, stage: "switch", error: error.message, rollbackError };
      }
    },
  });
  return { ...result, reusedCompact };
}
