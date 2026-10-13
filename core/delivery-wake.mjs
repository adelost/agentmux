// One stopped-pane wake seam for the delivery broker.
// Every refusal leaves the durable job pending; no wake observation is an ACK.

import { paneNeedsWake } from "./wake-admission.mjs";
import { isOwnerChannelJob } from "./ask-origin.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";

const pendingState = (drafted, ownsPaneDraft) =>
  drafted ? "drafted" : (ownsPaneDraft ? "pasting" : "pending");

/** WHAT: Routes one stopped target through wake gates. WHY: Keeps a wake attempt from becoming a false delivery ACK. */
export async function wakeDeliveryTarget({
  agent,
  job,
  wakeGate,
  wakeLifecycle,
  costAdmission,
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

  const costGate = async () => {
    if (job.kind !== "prompt" || !costAdmission) return { proceed: true, job };
    const verdict = await costAdmission(job, { lease }).catch(error => ({ ok: false, reason: error.message }));
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

/** WHAT: Returns the job the broker serves next for one pane. WHY: Lets the owner's message pass work held for a compact, without moving, cancelling or resending it. */
export function deliveryHead(jobs) {
  const open = jobs.filter(job => !TERMINAL_DELIVERY_STATES.has(job.status));
  if (!heldForCost(open[0])) return open[0] || null;
  return open.find(job => isOwnerChannelJob(job) && !heldForCost(job)) || open[0];
}
