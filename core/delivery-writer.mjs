// Keep the durable queue's writer lifetime independent of job outcomes.
import { appendEvent } from "./events.mjs";
import { withDeliveryPreparation } from "./delivery-preparation.mjs";

/** WHAT: Returns a target drain's outcome under a scoped writer lease. WHY: Prevents failed job or lock writes from blocking the next session writer. */
export async function withDeliveryWriter({ queue, agentName, pane, log, preparationTimeoutMs, now = Date.now }, work) {
  const context = { lease: null, job: null };
  const describe = error => `${agentName}:${pane} job ${context.job?.id || "preflight/lease"}: ${error.code || error.name}: ${error.message}`;
  try {
    const acquire = queue.acquireSessionLease || queue.acquireTargetLease;
    context.lease = acquire?.(agentName, pane) || null;
    if (acquire && !context.lease) return;
    return await withDeliveryPreparation({ timeoutMs: preparationTimeoutMs,
      onStage: (stage, elapsedMs) => log(`delivery preparation ${agentName}:${pane} ${context.job?.id || "preflight"}: ${stage} ${elapsedMs}ms`), onTimeout: error => {
      const job = context.job && queue.read(agentName, pane, context.job.id);
      // Never turn a draft, submit fence or an already-terminal result into an unsent retry.
      if (job && ["pending", "delivering", "pasting", "drafted", "submitting", "submitted"].includes(job.status)) {
        const unsent = ["pending", "delivering"].includes(job.status) && !job.draftOwned && !job.submitFenceAt && !job.submittedAt;
        const quotaHold = unsent && error.stage.startsWith("quota-floor:");
        queue.update(job, { ...(unsent ? { status: "pending", draftOwned: false } : {}),
          ...(quotaHold ? { costHold: true } : {}),
          lastReason: quotaHold ? `wake-refused:quota-floor: ${error.message}; fresh account reading unavailable; existing hold remains` : error.message,
          nextAttemptAt: now() + 60_000 });
      }
      log(`delivery broker ${agentName}:${pane} job ${job?.id || "preflight"}: ${error.message}`);
      try { appendEvent({ event: "delivery_queue", ts: new Date().toISOString(), session: agentName,
        pane, jobId: job?.id || null, state: "preparation_timeout", stage: error.stage }); } catch { /* diagnostics only */ }
    } }, () => work(context));
  } catch (error) {
    log(`delivery broker drain failed for ${describe(error)}`);
    throw error;
  } finally {
    try { context.lease?.release(); }
    catch (error) {
      log(`delivery broker lease release failed for ${describe(error)}`);
      throw error;
    }
  }
}
