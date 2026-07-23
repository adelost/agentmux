// Slash-command ingest guard for Codex panes.
//
// Codex writes no JSONL receipt for slash commands, so the legacy path
// verified delivery by scraping the composer. A dropped composer byte
// (/compact rendered as /compat) passed the warn-only draft check, submitted,
// and the engine's "Unrecognized command" reply then contained the needle
// that the stuck-composer heuristic looked for: rescue Enters, an honest
// delivered:false, and a broker that requeued the same payload 24 times in
// 34 minutes (2026-07-22 incident). This module owns the classified stops:
// exact echo proof before Enter, explicit engine rejection after Enter, and
// terminal closure without blind retry. Text that is not byte-identical to
// the submitted payload is never cleared or submitted by either stop.

import {
  codexComposerContainsPrompt,
  codexComposerEndsWithPrompt,
  codexComposerHasPasteBlock,
  codexComposerText,
} from "./codex-tui.mjs";
import { promptRequiresAtomicPaste } from "./prompt-paste.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue.mjs";

// Short commands only: their composer rendering fits the exact scraper.
const SLASH_COMMAND_RE = /^\/[a-z][\w-]*(\s|$)/i;
const MAX_GUARDED_COMMAND_CHARS = 160;
// Explicit engine refusals observed in the post-submit pane tail.
const ENGINE_REJECTION_RE = /\b(?:unrecognized|unknown|invalid)\s+(?:slash\s+)?command\b/i;
const REJECTION_WINDOW_LINES = 6;

const normalizeIdentity = (value) => String(value || "").replace(/\s+/g, "");

function commonPrefixLength(a, b) {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) index += 1;
  return index;
}

/** WHAT: Returns whether a payload is a short slash command. WHY: Limits hard echo enforcement to composer text that scrapes reliably. */
export function isShortSlashCommand(text) {
  const trimmed = String(text || "").trim();
  return trimmed.length > 1
    && trimmed.length <= MAX_GUARDED_COMMAND_CHARS
    && SLASH_COMMAND_RE.test(trimmed);
}

/**
 * Fail-closed for short slash commands: their composer rendering fits the
 * exact scraper, so no exact visible echo means no submit. A hidden or empty
 * composer blocks with kind "unverifiable" and the job stays pending for a
 * zoomed re-read instead of gambling Enter on unproven bytes. The verdict
 * never clears or edits composer text; ownership stays with the durable
 * delivery fence.
 *
 * WHAT: Compares the visible Codex composer against intended slash bytes.
 * WHY: Prevents a corrupted, foreign, or unproven draft from reaching Enter.
 */
export function classifyCodexSlashEcho({ prompt, snapshot }) {
  if (!isShortSlashCommand(prompt)) return { blocked: false, kind: "not-applicable" };
  const composer = codexComposerText(snapshot);
  if (composer === null || composer.trim() === "") {
    return {
      blocked: true,
      kind: "unverifiable",
      reason: `Codex slash echo unverifiable: no exact visible echo of "${prompt.trim().slice(0, 60)}" in the composer; submit refused (no Enter), draft left untouched`,
    };
  }
  const intended = normalizeIdentity(prompt.trim());
  const visible = normalizeIdentity(composer);
  if (visible === intended) return { blocked: false, kind: "match" };
  const shown = composer.trim().slice(0, 60);
  const wanted = prompt.trim().slice(0, 60);
  const corrupted = visible.startsWith("/")
    && commonPrefixLength(visible, intended) >= Math.max(2, Math.floor(intended.length / 2));
  return corrupted
    ? {
      blocked: true,
      kind: "echo-mismatch",
      reason: `Codex slash echo mismatch: composer shows "${shown}" but the payload is "${wanted}"; submit refused, draft left untouched`,
    }
    : {
      blocked: true,
      kind: "foreign",
      reason: `Codex composer holds an unrelated draft ("${shown}"); submit refused, foreign text left untouched`,
    };
}

/**
 * A refusal line is terminal truth only when it is NEW for this attempt: the
 * caller fingerprints the pane tail before submit, and a candidate line
 * counts only when it occurs more often after submit than before. A stale
 * "Unrecognized command: /old" already on screen can never close a fresh
 * /compact, and an identical refusal repeated by this attempt still counts
 * (occurrences increase). Without a READABLE fingerprint (capture failed)
 * the classifier never terminalizes: an unverifiable baseline must not
 * close a fresh attempt on stale bytes.
 *
 * WHAT: Checks the post-submit pane tail for a fresh explicit engine rejection.
 * WHY: Closes refused commands as not-ingested without ever trusting stale scrollback.
 */
export function detectSlashTerminalRejection(paneText, command, { beforeText = "", fingerprintOk = true } = {}) {
  if (!isShortSlashCommand(command)) return null;
  if (!fingerprintOk) return null;
  const afterText = String(paneText || "");
  const before = String(beforeText || "");
  const occurrences = (text, line) => {
    let count = 0;
    for (const row of text.split("\n")) if (row.trim() === line) count += 1;
    return count;
  };
  const hit = afterText
    .split("\n")
    .slice(-REJECTION_WINDOW_LINES)
    .map((line) => line.trim())
    .filter((line) => line
      && ENGINE_REJECTION_RE.test(line)
      && occurrences(afterText, line) > occurrences(before, line))[0];
  if (!hit) return null;
  return {
    rejected: true,
    line: hit.slice(0, 160),
    reason: `engine rejected the slash command after submit (pane shows "${hit.slice(0, 80)}"); classified not-ingested, no blind retry of the same payload`,
  };
}

/**
 * An atomic paste can collapse to a "[Pasted Content N chars]" block whose
 * literal text is never visible. Delivery clears any foreign draft before
 * pasting, so once that block appears it is OUR prompt; accept it so Enter
 * submits (Codex expands the block on send).
 *
 * WHAT: Returns once the exact drafted prompt appears in the Codex composer.
 * WHY: Separates a torn Ratatui repaint from a truly missing paste.
 */
export async function waitForExactCodexDraftEcho({ prompt, captureScreen, sleep, timeoutMs = 2_500 }) {
  const deadline = Date.now() + timeoutMs;
  const mayCollapse = promptRequiresAtomicPaste(prompt);
  while (true) {
    const snapshot = await captureScreen().catch(() => "");
    if (codexComposerContainsPrompt(snapshot, prompt)) return true;
    if (mayCollapse && codexComposerEndsWithPrompt(snapshot, prompt)) return true;
    if (mayCollapse && codexComposerHasPasteBlock(snapshot)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
}

/** WHAT: Returns whether a failed attempt earns one zoomed re-read. WHY: Keeps narrow-pane paint failures from parking a deliverable job. */
export function needsZoomFallback(result, submitted) {
  return Boolean(result?.zoomRecoverable && !result.delivered && !submitted);
}

/**
 * The rejection already proved the command left the composer and was parsed,
 * so this is not a pre-submit cancellation: it reuses the not-sent terminal
 * lane purely for its durable sender notice and FIFO release.
 *
 * WHAT: Turns an engine-rejected slash job into a visible terminal NOT SENT.
 * WHY: Prevents blind retries of a payload the engine explicitly refused.
 */
export async function terminalizeSlashRejection({ job, queue, now, queueEvent, notifyTerminal, reason }) {
  const current = queue.read(job.agentName, job.pane, job.id) || job;
  if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;
  const terminal = queue.update(current, {
    status: "cancelled",
    draftOwned: false,
    terminalAt: now(),
    nextAttemptAt: null,
    unverifiedNoticeSentAt: null,
    unverifiedNoticeNextAttemptAt: now(),
    metadata: {
      ...(current.metadata || {}),
      deliveryOutcome: "not-sent",
      deliveryRejection: "engine-rejected",
    },
    lastReason: `not sent: ${reason}`,
  });
  queueEvent(terminal, "cancelled", { reason: "engine-rejected" });
  return notifyTerminal(terminal);
}
