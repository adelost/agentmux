// Intake only. agy answers and busy state remain on the existing tmux fallback.
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readQwenJournalWindow as readWindow } from "./qwen-journal-window.mjs";
import { captureJsonlAppendCursor, hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { agyHome } from "./gemini-runtime.mjs";

/** WHAT: Defines agy's intake-only cursor kind. WHY: Keeps its receipt separate from another engine's append stream. */
export const GEMINI_CURSOR_KIND = "agy-history-v1";

// agy appends one row per submitted prompt: display (the exact text), timestamp, workspace, later conversationId.
const historyFile = home => join(agyHome(home), "history.jsonl");
const promptIn = (event, dir) => event?.workspace === dir && typeof event.display === "string" && event.display.trim()
  ? event.display.trim() : null;

/** WHAT: Builds a pre-submit append cursor on agy's prompt history. WHY: Prevents old identical prompts from acknowledging a new delivery. */
export function captureGeminiPromptCursor(prompt, { dir, home } = {}) {
  if (!dir || !prompt?.trim()) return null;
  const files = [historyFile(home)];
  return { ...captureJsonlAppendCursor(GEMINI_CURSOR_KIND, files), dir,
    generation: createHash("sha256").update(files.join("\n")).digest("hex") };
}

/** WHAT: Checks the exact history row agy wrote for this pane after submit. WHY: Keeps long wrapped TUI prompts out of delivery truth. */
export function geminiPromptAccepted(prompt, { cursor, dir, home } = {}) {
  if (!cursor || cursor.kind !== GEMINI_CURSOR_KIND || cursor.dir !== dir) return false;
  return hasJsonlEventAfterCursor([historyFile(home)], cursor, event => promptIn(event, dir) === prompt?.trim());
}

/** WHAT: Reads only the newest prompt this pane submitted. WHY: Gives tmux mirroring a stable turn identity without reading answers. */
export function latestGeminiPrompt({ dir, home } = {}) {
  if (!dir) return null;
  const rows = readWindow(historyFile(home), { maxBytes: 4 * 1024 * 1024 }).events
    .flatMap(event => promptIn(event, dir) ? [{ id: `${dir}@${event.timestamp}`, timestamp: event.timestamp, text: promptIn(event, dir) }] : []);
  return rows.sort((a, b) => a.timestamp - b.timestamp).at(-1) || null;
}
