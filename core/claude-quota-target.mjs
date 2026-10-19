// Shared target lookup for the delivery guard and the recovery sidecar.

import { join } from "node:path";
import { getAgent } from "../cli/config.mjs";
import { claudePaneSelection } from "./claude-model.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { runtimeAgentsPath } from "./runtime-defaults.mjs";
import {
  activeClaudeLimitReceipt,
  quotaRecoveryContinuation,
} from "./claude-quota-recovery.mjs";

/**
 * WHAT: Resolves one configured tmux Claude pane without creating filesystem state.
 * WHY: Keeps delivery and recovery bound to the same config and pane cwd.
 */
export function configuredClaudeTarget(agentName, pane = 0, {
  configPath = runtimeAgentsPath(),
} = {}) {
  let entry;
  try { entry = getAgent(configPath, agentName); }
  catch { return null; }
  const paneNumber = Number(pane) || 0;
  const paneConfig = entry.panes?.[paneNumber];
  if (!paneConfig || !/claude/iu.test(String(paneConfig.cmd || paneConfig.name || ""))) return null;
  if (entry.backend === "native") return null;
  return Object.freeze({
    agentName,
    pane: paneNumber,
    cwd: join(entry.dir, ".agents", String(paneNumber)),
    configPath,
    selection: claudePaneSelection(paneConfig),
  });
}

/**
 * WHAT: Reads one configured target's active persisted limit receipt.
 * WHY: Keeps callers from treating rendered quota prose as restart authority.
 */
export function activeClaudeLimitForTarget(agentName, pane = 0, options = {}) {
  const target = configuredClaudeTarget(agentName, pane, options);
  if (!target) return null;
  return activeClaudeLimitReceipt(target.cwd, { homeDir: options.homeDir || process.env.HOME });
}

/**
 * WHAT: Words the sender's warning for a message queued to a pane stopped at its Claude limit.
 * WHY: A queued handoff reads as delivered; on 2026-10-18 a lead role sat 5.8 h in a stopped pane.
 */
export function quotaStopSendNotice(agentName, pane, receipt) {
  if (!receipt) return null;
  const key = `${agentName}:${Number(pane) || 0}`;
  return `WARNING: ${key} is stopped at its Claude ${receipt.limitKind || "usage"} limit`
    + `${receipt.text ? ` (${receipt.text})` : ""}. The message waits in its queue until the pane recovers. `
    + `Keep any role you hand over until ${key} acknowledges.`;
}

/**
 * WHAT: Adds the stopped-recipient warning to a queued send's outcome and prints it for the sender.
 * WHY: Keeps the CLI send path from reporting only "queued" for a pane that cannot read it.
 */
export function warnQuotaStoppedRecipient(outcome, agentName, pane, {
  configPath = null,
  recipientLimit = null,
} = {}, warn = console.error) {
  let receipt = null;
  try {
    receipt = recipientLimit ? recipientLimit(agentName, pane)
      : configPath ? activeClaudeLimitForTarget(agentName, pane, { configPath }) : null;
  } catch { receipt = null; }
  const notice = quotaStopSendNotice(agentName, pane, receipt);
  if (notice) {
    outcome.notice = notice;
    warn(notice);
  }
  return outcome;
}

/**
 * WHAT: Checks a continuation against its durable restart authorization.
 * WHY: Prevents copied recovery prose from bypassing an active quota fence.
 */
export function isClaudeQuotaContinuationAuthorized(agentName, pane, receipt, prompt, {
  queue = null,
} = {}) {
  if (!receipt || prompt !== quotaRecoveryContinuation()) return false;
  const durableQueue = queue || createDeliveryQueue();
  return durableQueue.list(agentName, pane).some((job) =>
    job.source === "quota-recovery"
      && job.text === prompt
      && job.metadata?.quotaRecoverySessionId === receipt.sessionId
      && job.metadata?.quotaRecoveryLimitId === receipt.limitEventId
      && Number(job.metadata?.quotaRestartedAt) > 0);
}

/**
 * WHAT: Checks pane writes against the newest Claude limit receipt.
 * WHY: Prevents direct and queued send paths from typing into a non-ingesting composer.
 */
export function assertClaudeQuotaAvailable(agentName, pane = 0, options = {}) {
  const receipt = activeClaudeLimitForTarget(agentName, pane, options);
  if (!receipt) return null;
  if (isClaudeQuotaContinuationAuthorized(agentName, pane, receipt, options.prompt, options)) {
    return receipt;
  }
  // A verified exact-session restart already qualified quota for this same limit.
  // Its old banner persists until the first command or prompt is journaled.
  if (isClaudeQuotaContinuationAuthorized(agentName, pane, receipt, quotaRecoveryContinuation(), options)) return receipt;
  const error = new Error(
    `Claude quota is exhausted for ${agentName}:${Number(pane) || 0}; automatic exact-session recovery is pending`,
  );
  error.code = "AMUX_DELIVERY_BLOCKED";
  error.quotaLimited = true;
  error.quotaReceipt = receipt;
  throw error;
}

/** WHAT: Checks one quota-denied compact generation after reset. WHY: Prevents an unfinished intent from deadlocking its exact-session recovery. */
export function isRecoveredClaudeCompactAttempt(agentName, pane, attempt, { receipt, options = {}, now = Date.now() } = {}) {
  const limit = receipt || activeClaudeLimitForTarget(agentName, pane, options);
  if (!limit || limit.sessionId !== attempt?.sessionId || attempt.status === "VERIFIED"
      || !Number.isFinite(attempt.at) || !Number.isFinite(limit.resetAt) || now < limit.resetAt + 15_000
      || attempt.at >= limit.resetAt || limit.observedAt > attempt.at + 600_000
      || (attempt.status === "ATTEMPTING" && now < attempt.at + 600_000)) return false;
  return isClaudeQuotaContinuationAuthorized(agentName, pane, limit, quotaRecoveryContinuation(), options);
}
