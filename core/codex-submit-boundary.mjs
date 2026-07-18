// A completed Codex turn is an authoritative boundary for a prompt submitted
// while that turn was active. If the exact user event is still absent after
// the boundary and the composer is empty, the prompt was not ingested.

import { hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";

const CODEX_PROMPT_CURSOR_KIND = "codex-prompt-events-v1";
const MIN_RECOVERY_AGE_MS = 60_000;

/** WHAT: Returns whether Codex closed a turn after submit. WHY: Prevents a closed turn from fencing later messages. */
export function hasCodexTurnBoundaryAfterSubmit(cursor, submittedAt) {
  if (cursor?.kind !== CODEX_PROMPT_CURSOR_KIND
      || !Number.isFinite(Number(submittedAt))) return false;
  const files = Object.keys(cursor.positions || {});
  if (files.length === 0) return false;
  return hasJsonlEventAfterCursor(files, cursor, (event) => {
    const type = event?.type === "event_msg" ? event.payload?.type : null;
    const timestamp = Date.parse(String(event?.timestamp || ""));
    return (type === "task_complete" || type === "turn_aborted")
      && Number.isFinite(timestamp) && timestamp >= Number(submittedAt);
  });
}

/**
 * WHAT: Returns a Codex submit to the durable pending lane after a closed turn proves non-ingestion.
 * WHY: Prevents one swallowed Enter from fencing every later message for an hour.
 */
export async function recoverClosedCodexSubmit({
  job, agent, queue, exactEcho, acknowledge, now, onRecovered,
}) {
  const submittedAt = Number(job.submittedAt || job.submitFenceAt || 0);
  if (job.status !== "submitted" || job.kind !== "prompt"
      || job.metadata?.deliveryTransport === "native"
      || now() - submittedAt < MIN_RECOVERY_AGE_MS
      || !hasCodexTurnBoundaryAfterSubmit(job.echoCursor, submittedAt)
      || typeof agent.promptTransportState !== "function") return null;

  const transport = await agent.promptTransportState(job.agentName, job.pane, job.text)
    .catch(() => null);
  if (transport?.state !== "empty-idle" || transport.busy !== false) return null;
  if (await exactEcho(job)) return acknowledge(job, "late-echo-after-codex-turn-boundary");

  const current = queue.read(job.agentName, job.pane, job.id) || job;
  const currentSubmittedAt = Number(current.submittedAt || current.submitFenceAt || 0);
  if (current.status !== "submitted"
      || !hasCodexTurnBoundaryAfterSubmit(current.echoCursor, currentSubmittedAt)) return null;
  if (await exactEcho(current)) {
    return acknowledge(current, "late-echo-after-codex-turn-boundary");
  }

  const recovered = queue.update(current, {
    status: "pending",
    draftOwned: false,
    submittedAt: null,
    submitFenceAt: null,
    echoCursor: null,
    echoNotBeforeMs: null,
    nextAttemptAt: now(),
    cancelRequestStatus: current.cancelRequestedAt ? "requested" : current.cancelRequestStatus,
    metadata: {
      ...(current.metadata || {}),
      submittedRecoveryAt: now(),
      submittedRecoveryKind: "closed-codex-turn-resend",
    },
    lastReason: "Codex closed the active turn without ingesting this prompt; retrying from a fresh receipt cursor",
  });
  onRecovered(recovered);
  return recovered;
}
