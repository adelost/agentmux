// One stopped-pane wake seam for the delivery broker.
// Every refusal leaves the durable job pending; no wake observation is an ACK.

import { paneNeedsWake } from "./wake-admission.mjs";

const pendingState = (drafted, ownsPaneDraft) =>
  drafted ? "drafted" : (ownsPaneDraft ? "pasting" : "pending");

/** WHAT: Routes one stopped target through wake gates. WHY: Keeps a wake attempt from becoming a false delivery ACK. */
export async function wakeDeliveryTarget({
  agent,
  job,
  wakeGate,
  wakeLifecycle,
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
  if (!paneNeedsWake(processState)) return { proceed: true, job };

  const refuse = async (reason) => {
    const pending = queue.update(job, {
      status: pendingState(drafted, ownsPaneDraft),
      nextAttemptAt: now() + retryMs(job),
      lastReason: `wake-refused:${reason}`,
    });
    queueEvent(pending, "wake_refused", { reason: String(reason) });
    return { proceed: false, job: await notifyBlocked(pending) };
  };

  // Never type a prompt into a shell merely because this producer omitted
  // the optional wake policy. The durable queue can wait for a real CLI.
  if (!wakeGate) return refuse("target CLI is not running");
  const admission = await wakeGate({ agentName: job.agentName, pane: job.pane });
  if (!admission?.ok) return refuse(admission?.reason || "admission");
  const token = typeof wakeLifecycle?.prepare === "function"
    ? await wakeLifecycle.prepare({ agentName: job.agentName, pane: job.pane })
    : { ok: true, tracked: false };
  if (!token?.ok) return refuse(token?.reason || "sleep-lifecycle");

  try {
    await agent.ensureReady(job.agentName, job.pane);
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
    return { proceed: true, job };
  } catch (error) {
    return refuse(error instanceof Error ? error.message : "wake-verification-failed");
  }
}
