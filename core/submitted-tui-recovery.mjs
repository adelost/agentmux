// Recovery for an at-most-once submit fence whose coding process died before ingestion.

const MIN_RECOVERY_AGE_MS = 60_000;
const LIVE_IDLE_RESTART_AGE_MS = 2 * 60_000;
const RETRY_RECOVERY_MS = 30_000;

/** WHAT: Proves one pane has no coding process. WHY: Makes post-Enter redispatch depend on process truth, not pixels. */
function isProvenDeadRuntime(runtime) {
  return runtime?.running === false && (runtime.dead === true || runtime.shell === true);
}

/**
 * WHAT: Routes one submitted prompt only after its process is proven dead and JSONL is still empty.
 * WHY: Recovers an Enter consumed by a crashing TUI without duplicating a live or ingested turn.
 */
export async function recoverSubmittedTui({
  job, agent, queue, exactEcho, acknowledge, now, onRecovered, log = () => {},
}) {
  const recoveryKind = job.metadata?.submittedRecoveryKind || null;
  if (job.status !== "submitted" || job.kind !== "prompt"
      || job.metadata?.deliveryTransport === "native" || !job.echoCursor
      // One retained-draft Enter is the cheap first stage. If that did not
      // produce a receipt, the exact pane may still be restarted once below.
      || (job.metadata?.submittedRecoveryAt && recoveryKind !== "exact-draft-enter")
      || now() - Number(job.submittedAt || job.submitFenceAt || now()) < MIN_RECOVERY_AGE_MS
      || typeof agent.paneProcessState !== "function"
      || typeof agent.promptTransportState !== "function"
      || typeof agent.restartPaneExact !== "function") return null;

  const submittedAge = now() - Number(job.submittedAt || job.submitFenceAt || now());
  const runtime = await agent.paneProcessState(job.agentName, job.pane).catch(() => null);
  const transport = await agent.promptTransportState(job.agentName, job.pane, job.text)
    .catch(() => null);
  if (transport?.busy !== false) return null;
  if (await exactEcho(job)) return acknowledge(job, "late-echo-before-dead-tui-recovery");

  const current = queue.read(job.agentName, job.pane, job.id) || job;
  if (current.status !== "submitted" || await exactEcho(current)) {
    return current.status === "submitted"
      ? acknowledge(current, "late-echo-before-dead-tui-recovery")
      : current;
  }
  if (!recoveryKind && runtime?.running === true && transport.state === "drafted"
      && typeof agent.sendEnter === "function") {
    const fenced = queue.update(current, {
      metadata: {
        ...(current.metadata || {}),
        submittedRecoveryAt: now(),
        submittedRecoveryKind: "exact-draft-enter",
      },
      nextAttemptAt: now() + 1_000,
      lastReason: "exact submitted draft remained in an idle live composer; sent one bounded recovery Enter",
    });
    await agent.sendEnter(current.agentName, current.pane).catch((error) =>
      log(`submitted recovery Enter failed for ${current.agentName}:${current.pane}: ${error.message}`));
    onRecovered(fenced);
    return fenced;
  }

  const deadRuntime = isProvenDeadRuntime(runtime)
    && ["hidden", "empty-idle"].includes(transport.state);
  const stalledLiveRuntime = runtime?.running === true
    && submittedAge >= LIVE_IDLE_RESTART_AGE_MS
    && (transport.state === "empty-idle"
      || (recoveryKind === "exact-draft-enter" && transport.state === "drafted"));
  if (!deadRuntime && !stalledLiveRuntime) return null;

  const result = await agent.restartPaneExact(current.agentName, current.pane, {
    expectedDraft: transport.state === "drafted" ? current.text : null,
  })
    .catch((error) => ({ ok: false, reason: error.message }));
  if (!result?.ok) {
    const failed = queue.update(current, {
      nextAttemptAt: now() + RETRY_RECOVERY_MS,
      lastReason: `${deadRuntime ? "coding process died" : "live idle pane stopped ingesting"} before JSONL ingestion; exact resume failed: ${result?.reason || "unknown"}`,
    });
    log(`submitted TUI recovery failed for ${current.agentName}:${current.pane}: ${result?.reason || "unknown"}`);
    return failed;
  }
  if (await exactEcho(current)) return acknowledge(current, "late-echo-after-dead-tui-resume");

  const recovered = queue.update(current, {
    status: "pending",
    draftOwned: false,
    submittedAt: null,
    submitFenceAt: null,
    echoCursor: null,
    echoNotBeforeMs: null,
    nextAttemptAt: now(),
    metadata: {
      ...(current.metadata || {}),
      submittedRecoveryAt: now(),
      submittedRecoveryKind: deadRuntime ? "dead-process-resend" : "live-idle-resend",
      deadTuiRecoveredDialect: result.dialect || null,
    },
    lastReason: `${deadRuntime ? "coding process died" : "live idle pane stopped ingesting"} before JSONL ingestion; exact session resumed and the same durable prompt will retry once`,
  });
  onRecovered(recovered);
  return recovered;
}
