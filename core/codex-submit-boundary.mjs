// A completed Codex turn permits a bounded ambiguity verdict, not a resend.
// Missing prompt evidence cannot prove non-ingestion after a submit fence.

import { hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";

const CODEX_PROMPT_CURSOR_KIND = "codex-prompt-events-v1";
const MIN_RECOVERY_AGE_MS = 60_000;
/** WHAT: Names the legacy closed-turn resend marker. WHY: Keeps prior ambiguous submissions recognizable during cancellation and receipt reconciliation. */
export const CLOSED_CODEX_RECOVERY_KIND = "closed-codex-turn-resend";

/** WHAT: Checks for the legacy Codex resend marker. WHY: Keeps prior attempts visible without authorizing another physical delivery. */
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
 * WHAT: Resolves a closed Codex submit with an exact receipt or an explicit ambiguity verdict.
 * WHY: Prevents missing evidence from authorizing duplicate execution after submit.
 */
export async function recoverClosedCodexSubmit({
  job, agent, queue, exactEcho, acknowledge, terminalizeUnverified = null, now,
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

  if (typeof terminalizeUnverified !== "function") return null;
  return terminalizeUnverified(current, {
    ambiguity: hasClosedCodexRecovery(current) ? "closed-codex-recovery-exhausted" : "closed-codex-submit-unverified",
    reason: "Codex closed a turn without an exact JSONL prompt receipt; delivery remains unverified and will not be redispatched",
  });
}
