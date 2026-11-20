// A pane whose open work is only prompts the quota floor holds is served without the session writer lease.
// 12 Nov 14:24-14:58Z (deep:0): skyvw:1's floor-held job took the skyvw session lease on every 500 ms poll and 13 wake
// attempts in 9 min, so rotation refused the idle skyvw:0 as delivery-lease-busy until 14:53Z; claw:2's held job had 17.
import { TERMINAL_DELIVERY_STATES, blockedRetryMs } from "./delivery-queue-policy.mjs";
import { deliveryHead, isQuotaFloorHeldJob, deliveryFloorRefusal } from "./delivery-wake.mjs";
import { reportBlockedHandoffs } from "./delivery-handoff.mjs";
import { withDeliveryPreparation } from "./delivery-preparation.mjs";
import { createBuilderCap } from "./delivery-builder-cap.mjs";
import { isBusyFromCodexJsonl, latestCodexSessionFor } from "./codex-jsonl-reader.mjs";
import { panePathFor } from "./jsonl-reader.mjs";
import { runtimeAgentsPath } from "./runtime-defaults.mjs";
import { getAgent } from "../cli/config.mjs";
import { createBuilderCapFacts, isConfiguredCodex } from "./delivery-builder-cap-facts.mjs";

const unsentPrompt = job => job.kind === "prompt" && job.status === "pending" && !job.draftOwned
  && !job.submittedAt && !job.submitFenceAt && !job.cancelRequestStatus;

/**
 * WHAT: Builds the check that holds a floor-held pane without its writer lease.
 * WHY: Keeps a refused wake from locking the session rotation needs to move the pane off.
 */
export function createFloorHold({ queue, quotaFloor, now, preparationTimeoutMs, queueEvent, maybeNotifyBlocked, exactEcho, acknowledge, log, agent, configured = false }) {
  if (quotaFloor && configured && !quotaFloor.builderCap) quotaFloor.builderCap = createBuilderCap({ factsFor: createBuilderCapFacts({ factsFor: quotaFloor.windowsFor, queue }), isCodexTarget: isConfiguredCodex, now,
    isBusy: (name, pane) => { try { return capBusyState(panePathFor(getAgent(runtimeAgentsPath(), name), pane)); } catch { return null; } },
    jobs: () => queue.targets().flatMap(({ agentName, pane }) => queue.list(agentName, pane)) });
  return async function floorHold(agentName, pane) {
    if (!quotaFloor) return false;
    const jobs = queue.list(agentName, pane);
    const open = jobs.filter(job => !TERMINAL_DELIVERY_STATES.has(job.status));
    // Anything else on the pane (a draft, a submit fence, a cancel, a terminal notice) is served under the lease.
    if (!open.length || !open.every(unsentPrompt) || (queue.pendingTerminalNotices?.(agentName, pane) || []).length) return false;
    const head = deliveryHead(jobs);
    if (Number(head.nextAttemptAt || 0) > now()) return isQuotaFloorHeldJob(head);
    // The same bounded preparation the leased path uses: a stalled quota read keeps the hold, as delivery-writer.mjs does.
    const reason = await withDeliveryPreparation({ timeoutMs: preparationTimeoutMs,
      onStage: (stage, ms) => log(`delivery floor hold ${agentName}:${pane} ${head.id}: ${stage} ${ms}ms`),
      onTimeout: error => `quota-floor: ${error.message}; fresh account reading unavailable; existing hold remains` },
    () => deliveryFloorRefusal({ job: head, quotaFloor, now }));
    // The floor's refusals held a prompt that was never sent, so they spend no pre-submit budget: once it lifts the prompt starts
    // that budget afresh (12 Nov 18:12Z: skybar:0's head, 155 holds, was parked 5 min as spent after its move to Claude W).
    if (!reason) {
      const wasCap = String(head.lastReason || "").startsWith("wake-refused:quota-floor: builder-cap:");
      if (wasCap) {
        queueEvent(head, "builder_cap_released", { waitMs: Math.max(0, now() - Number(head.createdAt || now())) });
      }
      if (isQuotaFloorHeldJob(head)) queue.update(head, { attempts: 0, firstAttemptAt: null, costHold: null, nextAttemptAt: now(), ...(wasCap ? { lastReason: null } : {}) });
      return false;
    }
    const attempts = Number(head.attempts || 0) + 1;
    const retryMs = reason.includes("preparation-timeout") ? 60_000 : blockedRetryMs({ attempts });
    const held = queue.update(head, { status: "pending", attempts, firstAttemptAt: head.firstAttemptAt || now(),
      nextAttemptAt: now() + retryMs, lastReason: `wake-refused:${reason}`, costHold: true });
    if (head.lastReason !== held.lastReason) queueEvent(held, "wake_refused", { reason, lease: false });
    await maybeNotifyBlocked(held);
    await reportBlockedHandoffs({ agentName, pane, queue, now, exactEcho, acknowledge, log, agent });
    return true;
  };
}

// A Codex pane that never wrote a session has never run a turn, so it is idle, not unknown.
// 20 Nov 2026 (plan:0): next:8-16 counted as busy with no session file and their first prompt waited forever at the builder cap.
const capBusyState = paneDir => latestCodexSessionFor(paneDir) ? isBusyFromCodexJsonl(paneDir) : false;
