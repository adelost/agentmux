// Claude turn activity, separate from journal discovery and transport fences.

import { statSync } from "node:fs";
import { basename } from "node:path";
import { activeClaudeLimitReceiptFromEvents } from "./claude-limit-evidence.mjs";
import { CLAUDE_TERMINAL_STOP_REASONS as TERMINAL_STOP_REASONS, isClaudeTaskNotification, readClaudeTurnLifecycle, userPromptText } from "./claude-turn-lifecycle.mjs";

/** WHAT: Reads one persisted Claude turn's activity. WHY: Keeps terminal quota stops from becoming endless busy notifications without changing delivery receipts. */
export function isClaudeTurnBusy(events, userIdx, { sessionPath }) {
  // Claude records local slash-command UI bookkeeping as type:user events,
  // even though no assistant response will ever follow. Treating a trailing
  // /model (or similar) stdout record as a real prompt leaves an otherwise
  // idle pane "busy" forever and prevents stale delivery recovery. Only
  // wrapper-only events qualify; ordinary user text remains a real turn.
  if (isLocalCommandOnlyPrompt(userPromptText(events[userIdx]))) return false;

  if (isClaudeTaskNotification(events[userIdx])) {
    const receipt = activeClaudeLimitReceiptFromEvents(events, {
      sessionId: basename(sessionPath, ".jsonl"), sessionPath: sessionPath,
    });
    const notificationAt = Date.parse(events[userIdx].timestamp);
    const stop = receipt && events.find(event => event.uuid === receipt.limitEventId);
    if (stop?.message?.model === "<synthetic>" && stop.error === "rate_limit"
      && TERMINAL_STOP_REASONS.has(stop.message.stop_reason)
      && receipt.observedAt <= notificationAt) return false;
  }

  const { lastAssistant, pendingToolResult, nextTurnExists, interrupted } =
    readClaudeTurnLifecycle(events, userIdx);
  if (interrupted) return false;

  // If a later user prompt exists in the jsonl, claude accepted new input
  // which proves our turn finished, regardless of what stop_reason says.
  // This handles compacted sessions where stop_reason is null (the event
  // was written during streaming but the final end_turn was lost or never
  // written). Without this, isBusy polls for 10 minutes until maxDuration.
  if (nextTurnExists && lastAssistant) return false;

  // User prompt seen but no assistant response yet → claude is thinking
  if (!lastAssistant) return true;

  // There's a tool_result waiting for a new assistant message → busy
  if (pendingToolResult) return true;

  // Final assistant event: check its stop_reason
  const reason = lastAssistant.message?.stop_reason;
  if (TERMINAL_STOP_REASONS.has(reason)) return false;

  // Staleness check for damaged/compacted sessions: if the assistant has
  // real text content but stop_reason is null, AND the jsonl file hasn't
  // been written to in 15+ seconds, the turn is done. During active
  // streaming claude writes events every ~200ms so the file stays fresh;
  // a stale file with null stop_reason means the end_turn was lost.
  //
  // Observed in prod: 4 separate 10-minute hangs on 2026-04-09, all caused
  // by null stop_reason on sessions with 25 lines (compacted). The
  // nextTurnExists check above catches multi-turn cases; this catches the
  // last-turn case where no subsequent user prompt exists yet.
  if (reason === null || reason === undefined) {
    const hasContent = Array.isArray(lastAssistant.message?.content) &&
      lastAssistant.message.content.some(
        (b) => b.type === "text" && b.text?.trim(),
      );
    if (hasContent) {
      try {
        const mtime = statSync(sessionPath).mtimeMs;
        if (Date.now() - mtime > 15_000) return false;
      } catch {
        // stat failed, can't determine staleness, stay busy
      }
    }
  }

  // null / "tool_use" / missing / unknown → still working
  return true;
}

function isLocalCommandOnlyPrompt(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return /^(?:\s*(?:<local-command-stdout>[\s\S]*?<\/local-command-stdout>|<local-command-caveat>[\s\S]*?<\/local-command-caveat>|<command-name>[\s\S]*?<\/command-name>|<command-message>[\s\S]*?<\/command-message>|<command-args>[\s\S]*?<\/command-args>))+\s*$/.test(value);
}
