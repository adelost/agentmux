// Context facts and the compact step for one Claude account switch.
//
// The compact itself is the verified nightly pass: its own pane lease, a
// durable intent, the exact receipt and the shared once-per-context fence, so a
// failed or ambiguous compact is never paid for twice.

import { homedir } from "node:os";
import { join } from "node:path";
import { findChannelForPane } from "./config.mjs";
import { sendToChannelId } from "./send-notify.mjs";
import { compactDayKey, discoverCompactTargets, observeNightlyPane, runNightlyCompact } from "./nightly-compact.mjs";
import { nightlyCompactDecision } from "../core/nightly-compact.mjs";
import { contextMaintenanceAttempt } from "../core/context-maintenance.mjs";
import { readContextCostPolicy } from "../policies/context-cost.mjs";

// Statuses whose compact receipt is verified, whatever size the summary landed at, plus
// Claude's "Not enough messages to compact": no context, so no cache for the switch to lose.
const VERIFIED_COMPACT = new Set(["within-budget", "compacted-above-budget", "compacted-unmeasured", "nothing-to-compact"]);

const compactPolicy = (policy) => ({ enabled: true, maxTokens: policy.maxTokens, idleMinutes: 0 });

async function mirrorSwitchCompact(ctx, target, command) {
  const channel = findChannelForPane(ctx.configPath, target.agent.name, target.pane.index);
  if (!channel) return;
  const receipts = await sendToChannelId(channel, `[amux account switch] ${command}`);
  if (!receipts?.length) throw new Error("compact-mirror-unverified");
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
  const facts = await observe(ctx, target, { queue, now }).catch(() => null);
  if (!facts) return { target, facts: null, compactRefusal: "observation-unavailable", compacted: false };
  const prior = facts.sessionId
    ? contextMaintenanceAttempt(ctx.state, entry.agentName, entry.pane, { sessionId: facts.sessionId })
    : null;
  if (prior?.status === "VERIFIED") return { target, facts, compactRefusal: null, compacted: true };
  const refusal = prior ? `previous-compact-${String(prior.status).toLowerCase()}`
    : nightlyCompactDecision(facts, compactPolicy(policy), null);
  return { target, facts, compactRefusal: refusal === "within-budget" ? null : refusal, compacted: false };
}

/**
 * WHAT: Routes one warm, large pane through the verified compact on its source account.
 * WHY: Keeps the switch's cache miss on a small context, and an unverified compact from moving the pane.
 */
export async function compactBeforeSwitch(ctx, target, {
  queue = ctx.deliveryQueue, now = Date.now, policy = readContextCostPolicy(), run = runNightlyCompact,
} = {}) {
  const key = `${target.agent.name}:${target.pane.index}`;
  const pass = await run(ctx, {}, {
    targets: [target], queue, now, mirror: mirrorSwitchCompact,
    label: `Compact before account switch (${key})`,
    policy: compactPolicy(policy),
    path: join(homedir(), ".agentmux", "account-switch-compact", compactDayKey(now())),
  });
  const row = pass.rows.find((candidate) => candidate.pane === key) || pass.rows[0] || null;
  if (row && VERIFIED_COMPACT.has(row.status)) return { ok: true, status: row.status, afterTokens: row.afterTokens ?? null };
  return { ok: false, reason: `compact-${row?.status || "missing"}${row?.reason ? `:${row.reason}` : ""}` };
}
