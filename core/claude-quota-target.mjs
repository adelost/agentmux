// Shared target lookup for the delivery guard and the recovery sidecar.

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgent } from "../cli/config.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import {
  activeClaudeLimitReceipt,
  quotaRecoveryContinuation,
} from "./claude-quota-recovery.mjs";

const DEFAULT_AGENTS_YAML = fileURLToPath(new URL("../agents.yaml", import.meta.url));

/**
 * WHAT: Resolves one configured tmux Claude pane without creating filesystem state.
 * WHY: Keeps delivery and recovery bound to the same config and pane cwd.
 */
export function configuredClaudeTarget(agentName, pane = 0, {
  configPath = process.env.AGENTS_YAML || DEFAULT_AGENTS_YAML,
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
  const error = new Error(
    `Claude quota is exhausted for ${agentName}:${Number(pane) || 0}; automatic exact-session recovery is pending`,
  );
  error.code = "AMUX_DELIVERY_BLOCKED";
  error.quotaLimited = true;
  error.quotaReceipt = receipt;
  throw error;
}
