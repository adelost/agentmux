// Context facts and the compact step for one Claude account switch.
//
// The compact itself is the verified nightly pass: its own pane lease, a
// durable intent, the exact receipt and the shared once-per-context fence, so a
// failed or ambiguous compact is never paid for twice.

import { homedir } from "node:os";
import { join } from "node:path";
import { findChannelForPane } from "./config.mjs";
import { sendToChannelId } from "./send-notify.mjs";
import { compactDayKey, discoverCompactTargets, observeNightlyPane, runNightlyCompact, readNightlyCompactAttempt } from "./nightly-compact.mjs";
import { nightlyCompactDecision, isUnmeasuredCompact } from "../core/nightly-compact.mjs";
import { contextMaintenanceAttempt } from "../core/context-maintenance.mjs";
import { readContextCostPolicy } from "../policies/context-cost.mjs";
import { hasEmptyClaudeEpoch } from "../core/claude-empty-epoch.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue.mjs";
import { isHeldByPaneQuotaFloor } from "../core/delivery-wake.mjs";

// Statuses whose compact receipt is verified, whatever size the summary landed at, plus
// Claude's "Not enough messages to compact": no context, so no cache for the switch to lose,
// and a context another pass already compacted with no work since.
const VERIFIED_COMPACT = new Set(["within-budget", "compacted-above-budget", "compacted-unmeasured", "nothing-to-compact",
  "already-compacted"]);

const compactPolicy = (policy) => ({ enabled: true, maxTokens: policy.maxTokens, idleMinutes: 0 });
const reportDirectory = now => join(homedir(), ".agentmux", "account-switch-compact", compactDayKey(now));

async function mirrorSwitchCompact(ctx, target, command) {
  const channel = findChannelForPane(ctx.configPath, target.agent.name, target.pane.index);
  if (!channel) return;
  const receipts = await sendToChannelId(channel, `[amux account switch] ${command}`);
  if (!receipts?.length) throw new Error("compact-mirror-unverified");
}

/** WHAT: Counts the pane's open jobs that are live delivery. WHY: A prompt the old account's quota floor holds
 *  follows the pane to the account with room (account-rotation liveDeliveryCount), so it must not block the compact
 *  that move needs (lsrc:0 and skyvw:0, 27 Oct: 61 and 1 floor-held prompts kept both on Claude V). Unknown stays null. */
function liveQueued(queue, agentName, pane, queued) {
  if (queued === 0 || typeof queue?.list !== "function") return queued;
  try {
    const open = queue.list(agentName, pane).filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status));
    return open.filter((job) => !isHeldByPaneQuotaFloor(job, open)).length;
  } catch {
    return null;
  }
}

/**
 * WHAT: Reads one pane's context size, idle time and compact admission without waking it.
 * WHY: Keeps the switch plan on the same facts the nightly compact would act on.
 */
export async function observeSwitchContext(ctx, entry, {
  queue = ctx.deliveryQueue, now = Date.now, policy = readContextCostPolicy(),
  discover = discoverCompactTargets, observe = observeNightlyPane,
} = {}) {
  const targets = await discover(ctx, [entry.agent]).catch(() => []);
  const target = targets.find((candidate) => candidate.pane.index === entry.pane && candidate.engine === "claude");
  if (!target) return { target: null, facts: null, compactRefusal: "compact-target-missing", compacted: false };
  const observed = await observe(ctx, target, { queue, now }).catch(() => null);
  if (!observed) return { target, facts: null, compactRefusal: "observation-unavailable", compacted: false };
  const facts = { ...observed, queued: liveQueued(queue, entry.agentName, entry.pane, observed.queued) };
  const prior = facts.sessionId
    ? contextMaintenanceAttempt(ctx.state, entry.agentName, entry.pane, { sessionId: facts.sessionId, path: facts.sessionPath })
    : null;
  const previous = readNightlyCompactAttempt(reportDirectory(now()), compactDayKey(now()), `${entry.agentName}:${entry.pane}`);
  const unmeasured = isUnmeasuredCompact(previous, facts);
  // Claude clears usage at /compact. Its exact, unchanged compact epoch is
  // still proof for an idle restart; never turn that proof into zero tokens.
  if (!Number.isFinite(facts.tokens) && facts.running === true && facts.status === "idle"
      && facts.composerEmpty && facts.queued === 0
      && await hasEmptyClaudeEpoch({ sessionId: facts.sessionId, path: facts.sessionPath })) {
    return { target, facts, compactRefusal: null, compacted: true };
  }
  if (prior?.status === "VERIFIED" && !unmeasured) return { target, facts, compactRefusal: null, compacted: true };
  const refusal = prior && !(unmeasured && prior.status === "VERIFIED") ? `previous-compact-${String(prior.status).toLowerCase()}`
    : nightlyCompactDecision(facts, compactPolicy(policy), null);
  return { target, facts, compactRefusal: refusal === "within-budget" ? null : refusal, compacted: false };
}

/**
 * WHAT: Routes one warm, large pane through the verified compact on its source account.
 * WHY: Keeps the switch's cache miss on a small context, and an unverified compact from moving the pane.
 */
export async function compactBeforeSwitch(ctx, target, {
  queue = ctx.deliveryQueue, now = Date.now, policy = readContextCostPolicy(), run = runNightlyCompact, force = false,
  observeNightly = observeNightlyPane,
} = {}) {
  const key = `${target.agent.name}:${target.pane.index}`;
  // The run re-observes the pane before and after taking its lease; both readings count live delivery only.
  const observe = async (runCtx, pane, options) => {
    const facts = await observeNightly(runCtx, pane, options);
    return facts && { ...facts, queued: liveQueued(options?.queue ?? queue, pane.agent.name, pane.pane.index, facts.queued) };
  };
  const pass = await run(ctx, {}, {
    targets: [target], queue, now, observe, mirror: mirrorSwitchCompact, force, retryUnmeasured: target.engine === "claude",
    label: `Compact before account switch (${key})`,
    policy: compactPolicy(policy),
    path: reportDirectory(now()),
  });
  const row = pass.rows.find((candidate) => candidate.pane === key) || pass.rows[0] || null;
  if (target.engine === "claude" && row?.status === "compacted-unmeasured") {
    return { ok: false, reason: "compact-size-unmeasured" };
  }
  if (row && VERIFIED_COMPACT.has(row.status)) return { ok: true, status: row.status, afterTokens: row.afterTokens ?? null };
  return { ok: false, reason: `compact-${row?.status || "missing"}${row?.reason ? `:${row.reason}` : ""}` };
}
