// A compact boundary is an authoritative Claude session epoch change. When it
// lands after a durable submit fence and the exact prompt is absent, the old
// TUI could not ingest that prompt in the superseded epoch.

import { jsonlEventsAfterCursor } from "./jsonl-append-cursor.mjs";

const CLAUDE_PROMPT_CURSOR_KIND = "claude-prompt-events-v1";

/**
 * WHAT: Returns whether Claude committed a compact epoch after one durable submit fence.
 * WHY: Keeps an obsolete TUI epoch from holding a provably unconsumed prompt for an hour.
 */
export function hasClaudeCompactBoundaryAfterSubmit(cursor, submittedAt) {
  if (cursor?.kind !== CLAUDE_PROMPT_CURSOR_KIND
      || !Number.isFinite(Number(submittedAt))) return false;
  const files = Object.keys(cursor.positions || {});
  if (files.length === 0) return false;
  return jsonlEventsAfterCursor(files, cursor).some((event) =>
    event?.type === "system" && event?.subtype === "compact_boundary"
      && Date.parse(String(event.timestamp || "")) >= Number(submittedAt));
}

/**
 * WHAT: Routes a compact-superseded Claude job back through safe prompt delivery.
 * WHY: Keeps exact prompt delivery recoverable without weakening at-most-once receipt fencing.
 */
export async function recoverCompactedClaudeSubmit({
  job, agent, queue, exactEcho, acknowledge, now, onRecovered,
}) {
  if (job.status !== "submitted" || job.kind !== "prompt"
      || !hasClaudeCompactBoundaryAfterSubmit(job.echoCursor, job.submittedAt)
      || typeof agent.promptTransportState !== "function") return null;
  const transport = await agent.promptTransportState(job.agentName, job.pane, job.text)
    .catch(() => null);
  if (transport?.state !== "empty-idle") return null;
  if (await exactEcho(job)) return acknowledge(job, "late-echo-after-compact");
  const current = queue.read(job.agentName, job.pane, job.id) || job;
  if (current.status !== "submitted"
      || !hasClaudeCompactBoundaryAfterSubmit(current.echoCursor, current.submittedAt)) return null;
  if (await exactEcho(current)) return acknowledge(current, "late-echo-after-compact");
  const recovered = queue.update(current, {
    status: "pending", draftOwned: false, submittedAt: null, submitFenceAt: null,
    echoCursor: null, echoNotBeforeMs: null, nextAttemptAt: now(),
    cancelRequestStatus: current.cancelRequestedAt ? "requested" : current.cancelRequestStatus,
    lastReason: "Claude compacted after the submit fence without ingesting this prompt; retrying from a fresh receipt cursor",
  });
  onRecovered(recovered);
  return recovered;
}
