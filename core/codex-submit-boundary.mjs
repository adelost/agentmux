// A completed Codex turn is an authoritative boundary for a prompt submitted
// while that turn was active. If the exact user event is still absent after
// the boundary and the composer is empty, the prompt was not ingested.

import { hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";

const CODEX_PROMPT_CURSOR_KIND = "codex-prompt-events-v1";
const MIN_RECOVERY_AGE_MS = 60_000;
/** WHAT: Names the one allowed closed-turn recovery. WHY: Keeps every delivery seam on the same persisted recovery marker. */
export const CLOSED_CODEX_RECOVERY_KIND = "closed-codex-turn-resend";

/** WHAT: Checks whether a prompt already consumed its one safe Codex resend. WHY: A later task boundary must terminalize ambiguity instead of typing the prompt again. */
export function hasClosedCodexRecovery(job) {
  return job?.metadata?.submittedRecoveryKind === CLOSED_CODEX_RECOVERY_KIND;
}

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
  job, agent, queue, exactEcho, acknowledge, terminalizeUnverified = null, now, onRecovered,
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

  // The first closed turn is the one bounded recovery. A second closed turn
  // proves that the recovery itself crossed a submit boundary without an
  // exact JSONL user event. Returning to pending again would reset submittedAt
  // forever and physically retype the same prompt once per completed turn.
  if (hasClosedCodexRecovery(current)) {
    if (typeof terminalizeUnverified !== "function") return null;
    return terminalizeUnverified(current, {
      ambiguity: "closed-codex-recovery-exhausted",
      reason: "Codex closed the one bounded recovery turn without an exact JSONL prompt receipt; delivery is consumed/unverified and will not be redispatched",
    });
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
      submittedRecoveryKind: CLOSED_CODEX_RECOVERY_KIND,
      submittedRecoveryCount: 1,
    },
    lastReason: "Codex closed the active turn without ingesting this prompt; retrying from a fresh receipt cursor",
  });
  onRecovered(recovered);
  return recovered;
}
