// `amux stop <agent>` compacts its large panes first, while the prompt cache is
// still warm. Mattias 2026-09-27: a stop script killed skydive:1 at 153k one
// minute after its turn, so the next start had to read the whole context cold.
// One pane at a time through the verified nightly pass: lease, durable intent,
// exact receipt and the shared once-per-context fence.

import { homedir } from "node:os";
import { join } from "node:path";
import { findChannelForPane, listAgents } from "./config.mjs";
import { hasSession, killSession } from "./tmux.mjs";
import { sendToChannelId } from "./send-notify.mjs";
import { compactDayKey, discoverCompactTargets, observeNightlyPane, runNightlyCompact } from "./nightly-compact.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { CONTEXT_COST_POLICY } from "../policies/context-cost.mjs";

const COMPACT_ENGINES = new Set(["claude", "codex"]);

/**
 * WHAT: Returns the token limit above which a pane is compacted before stop.
 * WHY: Keeps a cold cache from paying for a compact that costs more than it saves.
 */
export function stopCompactLimit(idleMs, policy = CONTEXT_COST_POLICY) {
  return Number.isFinite(idleMs) && idleMs < policy.coldMs ? policy.maxTokens : policy.coldMaxTokens;
}

async function mirrorStopCompact(ctx, target, command) {
  const channel = findChannelForPane(ctx.configPath, target.agent.name, target.pane.index);
  if (!channel) return;
  const receipts = await sendToChannelId(channel, `[amux stop] ${command}`);
  if (!receipts?.length) throw new Error("compact-mirror-unverified");
}

/**
 * WHAT: Routes an agent's large idle panes through the verified nightly pass before its session stops.
 * WHY: Prevents a stop from leaving a large context to be re-read cold at the next start.
 */
export async function compactBeforeStop(ctx, name, {
  agents = listAgents(ctx.configPath), discover = discoverCompactTargets, observe = observeNightlyPane,
  run = runNightlyCompact, queue = createDeliveryQueue({ initialize: true }), now = Date.now,
} = {}) {
  // The normalized list carries backend; getAgent() does not, and without it
  // the target search takes a tmux agent for a native one and finds no panes.
  const agent = agents.find((entry) => entry.name === name);
  if (!agent) throw new Error(`agent '${name}' is not configured`);
  const rows = [];
  for (const target of await discover(ctx, [agent])) {
    if (!COMPACT_ENGINES.has(target.engine)) continue;
    const facts = await observe(ctx, target, { queue, now }).catch(() => null);
    if (facts?.running !== true || !Number.isFinite(facts.tokens)) continue;
    const maxTokens = stopCompactLimit(facts.idleMs);
    if (facts.tokens <= maxTokens) continue;
    const pass = await run(ctx, {}, {
      targets: [target], queue, now, mirror: mirrorStopCompact,
      label: `Compact before stop (${agent.name}:${target.pane.index})`,
      policy: { enabled: true, maxTokens, idleMinutes: 0 },
      path: join(homedir(), ".agentmux", "stop-compact", compactDayKey(now())),
    });
    rows.push(...pass.rows);
  }
  return rows;
}

/** WHAT: Routes one agent's stop through compaction of its large idle panes. WHY: Keeps a stopped context cheap to resume while a failed compact never blocks the stop. */
export async function cmdStop(name, ctx, { compact = true } = {}) {
  const configured = listAgents(ctx.configPath).find((entry) => entry.name === name);
  if (!configured) throw new Error(`Agent '${name}' not found`);
  if (configured.backend === "native") {
    console.log(`'${name}' is native and has no tmux session to stop; its sessions remain resumable in AMUX Code.`);
    return;
  }
  if (!(await hasSession(ctx, name))) {
    console.log(`No tmux session for '${name}'.`);
    return;
  }
  if (compact) {
    await compactBeforeStop(ctx, name)
      .catch((error) => console.error(`Compact before stop failed (${error.message}); stopping without it.`));
  }
  await killSession(ctx, name);
  console.log(`Stopped '${name}'.`);
}
