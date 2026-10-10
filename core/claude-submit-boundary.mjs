// A compact boundary is an authoritative Claude session epoch change. When it
// lands after a durable submit fence and the exact prompt is absent, the old
// TUI could not ingest that prompt in the superseded epoch.

import { hasJsonlEventAfterCursor, jsonlEventsAfterCursor } from "./jsonl-append-cursor.mjs";

const CLAUDE_PROMPT_CURSOR_KIND = "claude-prompt-events-v1";

const isRefusedCompact = (event, submittedAt) => event?.type === "system"
  && event.subtype === "local_command" && event.commandRun?.command === "compact"
  && event.commandOutcome?.kind === "failed"
  && Date.parse(String(event.timestamp || "")) >= Number(submittedAt);

const commandErrorText = (content) => String(content || "")
  .replace(/<\/?local-command-std(?:err|out)>/gu, "").trim();

// Claude journals a refused /compact at once ("You've hit your weekly limit");
// lsrc:2 still waited five minutes for a boundary on 2026-09-27.
/**
 * WHAT: Returns Claude's own error text when it refused a /compact after one submit fence.
 * WHY: Prevents a five-minute wait for a boundary that a refused compact never writes.
 */
export function claudeCompactRefusalAfterSubmit(cursor, submittedAt) {
  if (cursor?.kind !== CLAUDE_PROMPT_CURSOR_KIND
      || !Number.isFinite(Number(submittedAt))) return null;
  const refused = jsonlEventsAfterCursor(Object.keys(cursor.positions || {}), cursor)
    .find((event) => isRefusedCompact(event, submittedAt));
  return refused ? commandErrorText(refused.content) || "compact refused" : null;
}

const isEmptyCompact = (event, submittedAt) => event?.type === "system"
  && event.subtype === "local_command" && event.commandRun?.command === "compact"
  && /not enough messages to compact/iu.test(commandErrorText(event.content))
  && Date.parse(String(event.timestamp || "")) >= Number(submittedAt);

// Claude answers a session too short to summarize with plain stdout, not a failed
// command, so the refusal check above never saw it; api:2 held its project's
// delivery lease for twelve minutes on 2026-10-10 waiting for a boundary.
/**
 * WHAT: Returns whether Claude answered a /compact with "Not enough messages to compact" after one submit fence.
 * WHY: Keeps a session with nothing to compact from waiting for a boundary Claude never writes.
 */
export function claudeCompactHadNothingAfterSubmit(cursor, submittedAt) {
  if (cursor?.kind !== CLAUDE_PROMPT_CURSOR_KIND
      || !Number.isFinite(Number(submittedAt))) return false;
  return jsonlEventsAfterCursor(Object.keys(cursor.positions || {}), cursor)
    .some((event) => isEmptyCompact(event, submittedAt));
}

/**
 * WHAT: Returns whether Claude committed a compact epoch after one durable submit fence.
 * WHY: Keeps an obsolete TUI epoch from holding a provably unconsumed prompt for an hour.
 */
export function hasClaudeCompactBoundaryAfterSubmit(cursor, submittedAt) {
  if (cursor?.kind !== CLAUDE_PROMPT_CURSOR_KIND
      || !Number.isFinite(Number(submittedAt))) return false;
  const files = Object.keys(cursor.positions || {});
  if (files.length === 0) return false;
  return hasJsonlEventAfterCursor(files, cursor, (event) =>
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
