// A completed Codex turn permits a bounded ambiguity verdict, not a resend.
// Missing prompt evidence cannot prove non-ingestion after a submit fence.

import { hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { isHumanMessage } from "./delivery-notices.mjs";

const CODEX_PROMPT_CURSOR_KIND = "codex-prompt-events-v1";
const MIN_RECOVERY_AGE_MS = 60_000;
const HUMAN_BACKLOG_BOUND_MS = 10 * 60_000;
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

/** WHAT: Selects a safe ambiguity verdict from journal closure or a bounded human backlog. WHY: Missing evidence never permits redispatch, but must not starve later human input. */
function submitResolution(job, queue, nowMs) {
  const submittedAt = Number(job.submittedAt || job.submitFenceAt || 0);
  if (job.status !== "submitted" || job.kind !== "prompt"
      || job.echoCursor?.kind !== CODEX_PROMPT_CURSOR_KIND
      || job.metadata?.deliveryTransport === "native" || submittedAt <= 0
      || nowMs - submittedAt < MIN_RECOVERY_AGE_MS) return null;
  if (hasCodexTurnBoundaryAfterSubmit(job.echoCursor, submittedAt)) return {
    ambiguity: hasClosedCodexRecovery(job) ? "closed-codex-recovery-exhausted" : "closed-codex-submit-unverified",
    reason: "Codex closed a turn without an exact JSONL prompt receipt; delivery remains unverified and will not be redispatched",
  };
  const humanWaiting = nowMs - submittedAt >= HUMAN_BACKLOG_BOUND_MS
    && queue.list(job.agentName, job.pane).some(other => other.id !== job.id && other.createdAt >= job.createdAt
      && other.source === "discord" && isHumanMessage(other) && !TERMINAL_DELIVERY_STATES.has(other.status));
  return humanWaiting ? {
    ambiguity: "human-backlog-submit-unverified",
    reason: "Codex submit has no exact receipt after 10 minutes while human input waits; lane released without redispatch, delivery remains unverified",
  } : null;
}

/**
 * WHAT: Resolves a bounded Codex submit with an exact receipt or an explicit ambiguity verdict.
 * WHY: Prevents missing evidence from authorizing duplicate execution or starving human input.
 */
export async function recoverClosedCodexSubmit({
  job, queue, exactEcho, acknowledge, terminalizeUnverified = null, now,
}) {
  if (!submitResolution(job, queue, now())) return null;
  // This verdict never types, clears or interrupts. A newer goal turn may
  // already be busy; its composer cannot veto releasing an older ambiguity.
  if (await exactEcho(job)) return acknowledge(job, "late-echo-after-codex-turn-boundary");

  const current = queue.read(job.agentName, job.pane, job.id) || job;
  const decision = submitResolution(current, queue, now());
  if (!decision) return null;
  if (await exactEcho(current)) {
    return acknowledge(current, "late-echo-after-codex-turn-boundary");
  }

  if (typeof terminalizeUnverified !== "function") return null;
  return terminalizeUnverified(current, decision);
}
