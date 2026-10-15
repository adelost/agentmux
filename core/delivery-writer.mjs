// Keep the durable queue's writer lifetime independent of job outcomes.

/** WHAT: Returns a target drain's outcome under a scoped writer lease. WHY: Prevents failed job or lock writes from blocking the next session writer. */
export async function withDeliveryWriter({ queue, agentName, pane, log }, work) {
  const context = { lease: null, job: null };
  const describe = error => `${agentName}:${pane} job ${context.job?.id || "preflight/lease"}: ${error.code || error.name}: ${error.message}`;
  try {
    const acquire = queue.acquireSessionLease || queue.acquireTargetLease;
    context.lease = acquire?.(agentName, pane) || null;
    if (acquire && !context.lease) return;
    return await work(context);
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
