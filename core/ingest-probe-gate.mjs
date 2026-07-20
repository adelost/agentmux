// Ingest-probe gate for the delivery broker's write path.
//
// A retry with no receipt so far re-proves pane liveness with a disposable
// nonce probe before the real payload is committed again. A pane that does
// not ingest even the probe keeps its FIFO parked — the message is never
// retyped into a pane that proves nothing lands.

const DEFAULT_PROBE_INTERVAL_MS = 120_000;

/** WHAT: Builds the receiptless-retry probe gate over the agent seam. WHY: Keeps probe cadence and parking out of the delivery loop. */
export function createIngestProbeGate({
  agent,
  queue,
  queueEvent,
  now,
  blockedRetryMs,
  probeIntervalMs = DEFAULT_PROBE_INTERVAL_MS,
}) {
  /** WHAT: Gates one retry on a successful nonce probe. WHY: Prevents payload retypes into a pane that proves nothing lands. */
  return async function gateIngestProbe(job, { drafted = false, ownsPaneDraft = false } = {}) {
    if (job.kind !== "prompt"
        || job.metadata?.deliveryTransport === "native"
        || Number(job.attempts || 0) < 2
        || now() - Number(job.lastProbeAt || 0) < probeIntervalMs
        || typeof agent.probeIngest !== "function") {
      return { proceed: true, job };
    }
    const probe = await agent.probeIngest(job.agentName, job.pane)
      .catch((error) => ({ ok: false, reason: error.message }));
    if (probe && probe.ok === false) {
      const parked = queue.update(job, {
        status: drafted ? "drafted" : (ownsPaneDraft ? "pasting" : "pending"),
        lastProbeAt: now(),
        nextAttemptAt: now() + blockedRetryMs(job),
        lastReason: `ingest probe failed (${probe.reason || "no echo"}); FIFO kept, retry deferred`,
      });
      queueEvent(parked, "ingest_probe_failed", { reason: String(probe.reason || "") });
      return { proceed: false, job: parked };
    }
    return { proceed: true, job: queue.update(job, { lastProbeAt: now() }) };
  };
}
