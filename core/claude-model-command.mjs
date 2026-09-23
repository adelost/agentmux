import { normalizeClaudeModelName, resolveClaudeModel } from "./claude-model.mjs";
import { beginContextCompact, contextMaintenanceAttempt, rememberContextCompact } from "./context-maintenance.mjs";
import { sendSlashVerified } from "./delivery.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import { paneModelSelection, setPaneModelSelection } from "./pane-model-state.mjs";
import { verifiedClaudeCompact } from "./verified-compact.mjs";

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const observedModelId = raw => {
  const normalized = normalizeClaudeModelName(raw);
  return normalized.ok ? resolveClaudeModel(normalized.model) : null;
};

/** WHAT: Routes one idle Claude model change after an exact compact. WHY: Prevents an old conversation from crossing models without a compact receipt. */
export async function runLockedClaudeModelChange({
  agent, state, queue, name, pane, paneDir, targetModel,
  identityFor = latestClaudeSessionIdentity,
  compact = verifiedClaudeCompact,
  sendSlash = sendSlashVerified,
  wait = pause,
} = {}) {
  if (!state || !queue || !paneDir || !targetModel) return { ok: false, stage: "input", reason: "model-change-boundary-missing" };
  const model = resolveClaudeModel(targetModel);
  const current = async () => agent.getContext?.(name, pane) ?? agent.getContextPercent?.(name, pane);
  const process = await agent.paneProcessState?.(name, pane).catch(() => null);
  if (process?.running !== true) return { ok: false, stage: "stopped", reason: "pane-not-running" };
  const before = await current();
  const previousModel = observedModelId(before?.model);
  if (!previousModel) return { ok: false, stage: "status", reason: "current-model-unknown" };
  if (previousModel === model) {
    setPaneModelSelection(state, name, pane, model,
      before.effort || paneModelSelection(state, name, pane)?.effort || null);
    return { ok: true, unchanged: true, model };
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
      if (!receipt?.ok || !receipt.compactBoundary || receipt.sessionId !== identity.sessionId) {
        return { ok: false, stage: "compact", reason: receipt?.reason || "compact-boundary-unverified" };
      }
      rememberContextCompact(state, name, pane, receipt);
      reusedCompact = false;
    }
    const sent = await sendSlash(agent, name, pane, `/model ${model}`, { suppressReceipt: true,
      settleMs: 200, maxRescues: 0 });
    if (!sent.delivered || sent.via !== "command-receipt") {
      return { ok: false, stage: "switch", reason: "model-command-unverified" };
    }
    for (let attempt = 0; attempt < 10; attempt++) {
      const actual = await current();
      if (observedModelId(actual?.model) === model) {
        setPaneModelSelection(state, name, pane, model,
          actual.effort || paneModelSelection(state, name, pane)?.effort || null);
        return { ok: true, model, reusedCompact };
      }
      if (attempt < 9) await wait(250);
    }
    return { ok: false, stage: "verify", reason: "model-status-unverified" };
  } finally { lease.release(); }
}
