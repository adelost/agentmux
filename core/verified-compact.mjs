// Exact Claude compact receipt shared by sleep and account rotation.

import { claudeCompactRefusalAfterSubmit, hasClaudeCompactBoundaryAfterSubmit } from "./claude-submit-boundary.mjs";
import { latestCodexSessionIdentity } from "./codex-jsonl-reader.mjs";
import { sendSlashVerified } from "./delivery.mjs";
import { compactAccessBlocker } from "./nightly-compact.mjs";
import {
  captureJsonlAppendCursor, hasJsonlEventAfterCursor,
} from "./jsonl-append-cursor.mjs";

// Journals from 2026-08-15 to 2026-10-02: 21 of 221 Codex compacts ran past
// the former 180 s wait (longest 962 s) and were reported as not run; the
// longest of 190 Claude compacts took 294 s against a 300 s wait. Each wait
// is about twice the longest observed run, and ends early on the engine's
// own failure evidence.
const CLAUDE_COMPACT_POLLS = 600;
const CODEX_COMPACT_POLLS = 1_920;

const isCodexCompaction = (event) => event?.type === "compacted"
  || (event?.type === "event_msg" && event?.payload?.type === "context_compacted");
const isCodexTurnClosed = (event) => event?.type === "event_msg"
  && (event?.payload?.type === "task_complete" || event?.payload?.type === "turn_aborted");

const waitFor = async (attempts, delayMs, sleep, predicate) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await predicate()) return true;
    if (attempt + 1 < attempts) await sleep(delayMs);
  }
  return false;
};

/** WHAT: Routes one Claude compact through command and journal receipts. WHY: Prevents account rotation from killing unproven context. */
export async function verifiedClaudeCompact({
  agent,
  agentName,
  pane,
  paneDir,
  latestIdentity,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sendSlash = sendSlashVerified,
  hasBoundary = hasClaudeCompactBoundaryAfterSubmit,
  compactRefusal = claudeCompactRefusalAfterSubmit,
  pollAttempts = CLAUDE_COMPACT_POLLS,
  pollMs = 1_000,
  settleMs = 200,
  command = "/compact",
  onCommandAccepted = () => {},
} = {}) {
  const before = latestIdentity(paneDir);
  if (!before?.sessionId) return { ok: false, reason: "pre-compact-session-missing" };
  const cursor = await agent.capturePromptEchoCursor(
    agentName,
    pane,
    `AMUX-COMPACT-FENCE-${now()}`,
  ).catch(() => null);
  if (!cursor || !Object.keys(cursor.positions || {}).length) {
    return { ok: false, reason: "compact-cursor-missing" };
  }
  const submittedAt = now();
  const deadline = submittedAt + pollAttempts * pollMs;
  const sent = await sendSlash(agent, agentName, pane, command, {
    suppressReceipt: true,
    settleMs,
    // Claude may persist the local-command receipt only after compacting.
    // Share one bounded wait with the boundary check; never send extra Enter
    // while it is running. The journal alone proves the rest, so the pane
    // needs no TUI writer once Enter is sent.
    receiptTimeoutMs: pollAttempts * pollMs,
    maxRescues: 0,
    sleep,
    onSubmitted: onCommandAccepted,
  });
  const screen = await agent.captureScreen?.(agentName, pane).catch(() => "");
  const blocked = compactAccessBlocker(screen);
  if (blocked) return { ok: false, reason: blocked };
  if (!sent.delivered || sent.via !== "command-receipt") {
    return { ok: false, reason: "compact-command-unverified" };
  }
  let refusal = null;
  const boundary = await waitFor(
    Math.max(1, Math.min(pollAttempts, Math.floor((deadline - now()) / pollMs) + 1)),
    pollMs,
    sleep,
    () => {
      refusal = compactRefusal(cursor, submittedAt);
      return Boolean(refusal) || hasBoundary(cursor, submittedAt);
    },
  );
  if (refusal) {
    return { ok: false, reason: /limit/iu.test(refusal) ? "provider-usage-limited" : "compact-refused", detail: refusal };
  }
  if (!boundary) return { ok: false, reason: "compact-boundary-missing" };
  const after = latestIdentity(paneDir);
  if (!after?.sessionId) return { ok: false, reason: "post-compact-session-missing" };
  if (after.sessionId !== before.sessionId) {
    return { ok: false, reason: "compact-session-changed" };
  }
  return {
    ok: true,
    cursor,
    submittedAt,
    sessionId: after.sessionId,
    commandReceipt: sent.via,
    compactBoundary: true,
  };
}

/** WHAT: Routes one Codex compact through the TUI and rollout boundary. WHY: Prevents Dream from running on stale pre-compact context. */
export async function verifiedCodexCompact({
  agent,
  agentName,
  pane,
  paneDir,
  latestIdentity = latestCodexSessionIdentity,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  sendSlash = sendSlashVerified,
  pollAttempts = CODEX_COMPACT_POLLS,
  pollMs = 1_000,
  settleMs = 200,
  maxRescues = 2,
  onCommandAccepted = () => {},
} = {}) {
  const before = latestIdentity(paneDir);
  if (!before?.sessionId || !before?.path) {
    return { ok: false, reason: "pre-compact-session-missing" };
  }
  const cursor = captureJsonlAppendCursor("codex-compact-events-v1", [before.path]);
  if (!Object.keys(cursor.positions || {}).length) {
    return { ok: false, reason: "compact-cursor-missing" };
  }
  const command = await sendSlash(agent, agentName, pane, "/compact", {
    suppressReceipt: true,
    settleMs,
    maxRescues,
    sleep,
  });
  if (!command.delivered) return { ok: false, reason: "compact-command-unverified" };
  await onCommandAccepted();

  // Codex writes the compaction before it closes the compact turn, so a
  // closed turn without one is a finished compact that did not run.
  let outcome = null;
  await waitFor(pollAttempts, pollMs, sleep, () => {
    const current = latestIdentity(paneDir);
    const files = [...new Set([before.path, current?.path].filter(Boolean))];
    if (hasJsonlEventAfterCursor(files, cursor, isCodexCompaction)) outcome = "compacted";
    else if (hasJsonlEventAfterCursor(files, cursor, isCodexTurnClosed)) outcome = "turn-closed";
    return outcome !== null;
  });
  if (outcome === "turn-closed") return { ok: false, reason: "compact-ended-without-boundary" };
  if (!outcome) return { ok: false, reason: "compact-boundary-missing" };
  const after = latestIdentity(paneDir);
  if (!after?.sessionId) return { ok: false, reason: "post-compact-session-missing" };
  if (after.sessionId !== before.sessionId) {
    return { ok: false, reason: "compact-session-changed" };
  }
  return {
    ok: true,
    cursor,
    sessionId: after.sessionId,
    commandReceipt: "codex-compact-boundary",
    compactBoundary: true,
  };
}
