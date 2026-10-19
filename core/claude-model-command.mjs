import { isRequestedClaudeModel, normalizeClaudeModelName, resolveClaudeModel } from "./claude-model.mjs";
import { keepClaudeDefaultModel, putBackLandedDefault } from "./claude-default-model.mjs";
import { readClaudeFooterModel } from "./claude-statusline.mjs";
import { beginContextCompact, contextMaintenanceAttempt, rememberContextCompact } from "./context-maintenance.mjs";
import { sendSlashVerified } from "./delivery.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import { beginPaneModelSwitch, endPaneModelSwitch, landedPaneModelSwitch, paneModelSelection, setPaneModelSelection } from "./pane-model-state.mjs";
import { verifiedClaudeCompact } from "./verified-compact.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Claude Code records /model in the session only once it has saved the default: 3.3 s on skyvw:2 (2026-10-19).
const MODEL_RECEIPT_MS = 15_000;
const observedModelId = raw => {
  // The footer's "Opus 5.5 (1M context)" is the 1M-context variant of the same model id.
  const normalized = normalizeClaudeModelName(String(raw ?? "").replace(/\s*\(1M context\)\s*$/iu, "[1m]"));
  return normalized.ok ? resolveClaudeModel(normalized.model) : null;
};

/**
 * WHAT: Sends /model and saves the full id once the pane shows the requested model.
 * WHY: The model-watch reads an unsaved switch to a cheaper model as a downgrade
 *      and parks the pane (skydive:1 and claw:2, 2026-10-19).
 */
async function switchVerified({ agent, state, name, pane, from, model, keep, current, sendSlash, wait }) {
  // A turn the watcher mirrors before the choice is saved shows the new model, and Claude Code
  // may still run a /model amux stopped waiting for, so only a verified switch ends the mark.
  beginPaneModelSwitch(state, name, pane, { from, to: model, keep });
  const sent = await sendSlash(agent, name, pane, `/model ${model}`, { suppressReceipt: true,
    settleMs: 200, maxRescues: 0, receiptTimeoutMs: MODEL_RECEIPT_MS });
  // The footer proves the switch even when its record is missing.
  for (let attempt = 0; attempt < 10; attempt++) {
    const actual = await current();
    const running = observedModelId(actual?.model);
    if (isRequestedClaudeModel(running, model)) {
      setPaneModelSelection(state, name, pane, running,
        actual.effort || paneModelSelection(state, name, pane)?.effort || null);
      endPaneModelSwitch(state, name, pane);
      return { ok: true, model: running };
    }
    if (attempt < 9) await wait(250);
  }
  return sent.delivered && sent.via === "command-receipt"
    ? { ok: false, stage: "verify", reason: "model-status-unverified" }
    : { ok: false, stage: "switch", reason: "model-command-unverified" };
}

/**
 * WHAT: Resolves a marked switch that landed after amux model returned, saving back the default it kept.
 * WHY: Keeps a switch amux could not verify from staying half done (skyvw:2, 2026-10-19).
 */
export function settleLandedClaudeModelSwitch(state, name, pane, reading, { putBack = putBackLandedDefault } = {}) {
  const change = landedPaneModelSwitch(state, name, pane, reading);
  if (!change) return null;
  const defaults = putBack(change.keep || {});
  // A switch still in progress holds the lock and ends its own mark.
  if (!defaults.busy) endPaneModelSwitch(state, name, pane);
  return defaults;
}

/** WHAT: Routes one idle Claude model change after an exact compact. WHY: Prevents an old conversation from crossing models without a compact receipt. */
export async function runLockedClaudeModelChange({
  agent, state, queue, name, pane, paneDir, targetModel,
  identityFor = latestClaudeSessionIdentity,
  compact = verifiedClaudeCompact,
  sendSlash = sendSlashVerified,
  keepDefault = keepClaudeDefaultModel,
  wait = pause,
} = {}) {
  if (!state || !queue || !paneDir || !targetModel) return { ok: false, stage: "input", reason: "model-change-boundary-missing" };
  const model = resolveClaudeModel(targetModel);
  const reported = async () => agent.getContext?.(name, pane) ?? agent.getContextPercent?.(name, pane);
  // A fresh or just-compacted pane's footer names its live model before its journal does.
  const current = async () => {
    const screen = typeof agent.captureScreen === "function" ? await agent.captureScreen(name, pane).catch(() => null) : null;
    const live = readClaudeFooterModel(screen);
    const context = await reported();
    return live ? { ...context, model: live.model, effort: live.effort || context?.effort || null } : context;
  };
  const process = await agent.paneProcessState?.(name, pane).catch(() => null);
  if (process?.running !== true) return { ok: false, stage: "stopped", reason: "pane-not-running" };
  const before = await current();
  const previousModel = observedModelId(before?.model);
  if (!previousModel) return { ok: false, stage: "status", reason: "current-model-unknown" };
  if (isRequestedClaudeModel(previousModel, model)) {
    setPaneModelSelection(state, name, pane, previousModel,
      before.effort || paneModelSelection(state, name, pane)?.effort || null);
    return { ok: true, unchanged: true, model: previousModel };
  }

  const lease = queue.acquireSessionLease(name);
  if (!lease) return { ok: false, stage: "lease", reason: "delivery-lease-busy" };
  try {
    if (queue.list(name, pane).some(job => !TERMINAL_DELIVERY_STATES.has(job.status))) {
      return { ok: false, stage: "delivery", reason: "older-message-pending" };
    }
    const [busy, input] = await Promise.all([
      agent.isBusy(name, pane), agent.promptTransportState(name, pane, ""),
    ]);
    if (busy !== false || input?.state !== "empty-idle") {
      return { ok: false, stage: "idle", reason: "pane-or-composer-not-idle" };
    }
    const identity = identityFor(paneDir);
    if (!identity?.sessionId || !identity.path) return { ok: false, stage: "identity", reason: "exact-session-missing" };
    const prior = contextMaintenanceAttempt(state, name, pane, identity);
    if (prior && prior.status !== "VERIFIED") {
      return { ok: false, stage: "compact", reason: `prior-${prior.status.toLowerCase()}` };
    }
    let reusedCompact = Boolean(prior);
    if (!prior) {
      beginContextCompact(state, name, pane, identity);
      const receipt = await compact({ agent, agentName: name, pane, paneDir,
        latestIdentity: identityFor, sendSlash });
      // A session with nothing to compact has no context or cache to lose by changing model.
      const compacted = (receipt?.ok && receipt.compactBoundary) || receipt?.nothingToCompact === true;
      if (!compacted || receipt.sessionId !== identity.sessionId) {
        return { ok: false, stage: "compact", reason: receipt?.reason || "compact-boundary-unverified" };
      }
      rememberContextCompact(state, name, pane, receipt);
      reusedCompact = false;
    }
    const kept = await keepDefault((keep) => switchVerified({ agent, state, name, pane, from: previousModel, model,
      keep, current, sendSlash, wait }));
    if (kept.busy) return { ok: false, stage: "default", reason: "default-model-busy" };
    return { ...kept.result, ...(kept.result.ok ? { reusedCompact } : {}), defaultModel: kept.defaults };
  } finally { lease.release(); }
}
