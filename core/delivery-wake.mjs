// One stopped-pane wake seam for the delivery broker.
// Every refusal leaves the durable job pending; no wake observation is an ACK.

import { paneNeedsWake } from "./wake-admission.mjs";
import { isOwnerChannelJob } from "./ask-origin.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { quotaFloorHold, staleWindows } from "./quota-park.mjs";
import { QUOTA_WIND_DOWN_ORIGIN } from "./quota-wind-down.mjs";
import { deliveryPreparationStage } from "./delivery-preparation.mjs";

const pendingState = (drafted, ownsPaneDraft) =>
  drafted ? "drafted" : (ownsPaneDraft ? "pasting" : "pending");

/** WHAT: Routes one stopped target through wake gates. WHY: Keeps a wake attempt from becoming a false delivery ACK. */
export async function wakeDeliveryTarget({
  agent,
  job,
  wakeGate,
  wakeLifecycle,
  costAdmission,
  quotaFloor = null,
  lease = null,
  drafted,
  ownsPaneDraft,
  queue,
  now,
  retryMs,
  queueEvent,
  notifyBlocked,
}) {
  if (typeof agent.paneProcessState !== "function") return { proceed: true, job };
  const processState = await agent.paneProcessState(job.agentName, job.pane).catch(() => null);

  // costHold: held for a compact or for context evidence, which only the owner's message may pass.
  const refuse = async (reason, costHold = false) => {
    const pending = queue.update(job, {
      status: pendingState(drafted, ownsPaneDraft),
      nextAttemptAt: now() + retryMs(job),
      lastReason: `wake-refused:${reason}`,
      costHold: costHold || null,
    });
    queueEvent(pending, "wake_refused", { reason: String(reason) });
    return { proceed: false, job: await notifyBlocked(pending) };
  };

  // lsrc:0 2026-10-19: at the floor an account's last few percent are for clean stops, compacts and handovers, so
  // automatic work waits; a person's own message still goes through (context-maintenance.mjs, 2026-09-26).
  // A failed reading cannot prove room or lift an existing hold: it holds unless the account's last good reading, as
  // used as it can be by now, still leaves room. A spent Codex window holds paid-credit turns too.
  const holdOf = (facts) => quotaFloorHold({ windows: facts?.stale ? staleWindows(facts.windows, facts.observedAt, now())
    : facts?.windows, floorPercent: quotaFloor.percent, now: now(),
    provider: facts?.account?.provider, creditsAllowed: quotaFloor.creditsAllowed === true });
  const floorReason = async () => {
    if (!quotaFloor || isOwnerChannelJob(job)) return null;
    const paneKey = `${job.agentName}:${job.pane}`;
    const cached = await deliveryPreparationStage("quota-floor:cached", () => quotaFloor.windowsFor(paneKey)).catch(() => ({ unavailable: true }));
    if (!cached?.unavailable && !holdOf(cached)) return null;
    // A pane quota recovery just moved may still be listed on its old account; re-read where it runs now.
    const fresh = await deliveryPreparationStage("quota-floor:fresh", () => quotaFloor.windowsFor(paneKey, { fresh: true })).catch(() => null);
    if (!fresh || fresh.unavailable) return "quota-floor: fresh account reading unavailable; existing hold remains";
    const hold = holdOf(fresh);
    // A clean-stop nudge may use the weekly reserve, never paid Codex credits.
    if (!hold || (job.source === QUOTA_WIND_DOWN_ORIGIN && !hold.credits)) return null;
    const name = `${fresh.account?.name || "its account"}${fresh.stale ? ` (reading failed; last good ${new Date(fresh.observedAt).toISOString()})` : ""}`;
    return hold.credits
      ? `quota-floor: ${name} has spent its ${hold.window === "session" ? "5h" : hold.window} window until ${hold.resetsAt};`
        + " a turn now draws paid credits"
      : `quota-floor: ${name} has ${hold.leftPercent} % of its week left (floor ${quotaFloor.percent} %) until ${hold.resetsAt}`;
  };

  const costGate = async () => {
    if (job.kind !== "prompt") return { proceed: true, job };
    const floor = await floorReason();
    if (floor) return refuse(floor, true);
    if (!costAdmission) return { proceed: true, job: job.costHold ? queue.update(job, { costHold: null }) : job };
    const verdict = await deliveryPreparationStage("cost-admission", () => costAdmission(job, { lease })).catch(error => ({ ok: false, reason: error.message }));
    if (!verdict?.ok) return refuse(verdict?.reason || "context-cost-unverified", verdict?.held === true);
    return { proceed: true, job: job.costHold ? queue.update(job, { costHold: null }) : job };
  };
  if (!paneNeedsWake(processState)) return costGate();

  // Never type a prompt into a shell merely because this producer omitted
  // the optional wake policy. The durable queue can wait for a real CLI.
  if (job.source === "drift-guard") return refuse("drift reminder cannot wake a stopped pane");
  if (!wakeGate) return refuse("target CLI is not running");
  const admission = await wakeGate({ agentName: job.agentName, pane: job.pane });
  if (!admission?.ok) return refuse(admission?.reason || "admission");
  const token = typeof wakeLifecycle?.prepare === "function"
    ? await wakeLifecycle.prepare({ agentName: job.agentName, pane: job.pane })
    : { ok: true, tracked: false };
  if (!token?.ok) return refuse(token?.reason || "sleep-lifecycle");

  try {
    // A start that finds this context's compact unverified holds automatic work.
    await agent.ensureReady(job.agentName, job.pane, isOwnerChannelJob(job) ? { work: "HUMAN" } : null);
    const ready = await agent.paneProcessState(job.agentName, job.pane).catch(() => null);
    if (paneNeedsWake(ready)) throw new Error("target CLI did not start");
    if (typeof wakeLifecycle?.complete === "function") {
      const completed = await wakeLifecycle.complete({
        agentName: job.agentName,
        pane: job.pane,
        token,
        processState: ready,
      });
      if (!completed?.ok) throw new Error(completed?.reason || "wake-verification-failed");
    }
    return costGate();
  } catch (error) {
    return refuse(error instanceof Error ? error.message : "wake-verification-failed", error?.costHold === true);
  }
}

const heldForCost = job => job?.costHold === true && job.status === "pending" && !job.draftOwned;

// lsrc:0 2026-10-21: the night's rotation refused skyvw:0, lsrc:0 and api:0 as live delivery for prompts the floor held.
/** WHAT: Checks whether only the quota floor holds an unsent prompt. WHY: Lets an account move take the prompt along instead of waiting on it. */
export const isQuotaFloorHeldJob = job => heldForCost(job) && !job.submittedAt && !job.submitFenceAt
  && String(job.lastReason || "").startsWith("wake-refused:quota-floor:");

/** WHAT: Returns the job the broker serves next for one pane. WHY: Lets the owner's message pass work held for a compact, without moving, cancelling or resending it. */
export function deliveryHead(jobs) {
  const open = jobs.filter(job => !TERMINAL_DELIVERY_STATES.has(job.status));
  if (!heldForCost(open[0])) return open[0] || null;
  const owner = open.find(job => isOwnerChannelJob(job) && !heldForCost(job));
  if (owner) return owner;
  // An explicitly requested compact can settle an untouched cost hold. Never
  // jump any physical submit fence or a draft owned by either job.
  return !open[0].submitFenceAt && !open[0].submittedAt && open.find(job => job.kind === "slash"
    && job.source === "amux:compact" && job.status === "pending" && /^\/compact(?:\s|$)/u.test(job.text || "")
    && !job.draftOwned && !job.submitFenceAt && !job.submittedAt) || open[0];
}
