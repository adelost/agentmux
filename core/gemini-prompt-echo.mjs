// Intake only. Gemini answers and busy state remain on the existing tmux fallback.
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readQwenJournalWindow as readWindow } from "./qwen-journal-window.mjs";
import { captureJsonlAppendCursor, hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";

/** WHAT: Defines Gemini's intake-only cursor kind. WHY: Keeps its receipt separate from another engine's append stream. */
export const GEMINI_CURSOR_KIND = "gemini-prompt-v1";

function filesFor({ sessionId, home = homedir() } = {}) {
  if (!/^[0-9a-f-]{36}$/iu.test(sessionId || "")) return [];
  const root = join(home, ".gemini", "tmp");
  const files = [];
  try {
    for (const project of readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const chats = join(root, project.name, "chats");
      try {
        for (const name of readdirSync(chats)) {
          if (!name.startsWith("session-") || !name.endsWith(`-${sessionId.slice(0, 8)}.jsonl`)) continue;
          const file = join(chats, name);
          const head = readWindow(file, { head: true, maxBytes: 64 * 1024 }).events[0];
          if (head?.sessionId === sessionId && head.kind === "main") files.push(file);
        }
      } catch { /* a new session has no chats directory yet */ }
    }
  } catch { /* no Gemini history yet */ }
  return files.sort();
}

const userText = event => {
  if (event?.type !== "user") return null;
  const text = typeof event.content === "string" ? event.content
    : (event.content || []).filter(part => typeof part?.text === "string").map(part => part.text).join("\n");
  return text.trim() && !/^\s*<session_context>/u.test(text) ? text.trim() : null;
};

/** WHAT: Builds a pre-submit exact-session append cursor. WHY: Prevents old identical prompts from acknowledging a new delivery. */
export function captureGeminiPromptCursor(prompt, options) {
  if (!options?.sessionId || !prompt?.trim()) return null;
  const files = filesFor(options);
  return { ...captureJsonlAppendCursor(GEMINI_CURSOR_KIND, files), sessionId: options.sessionId,
    generation: createHash("sha256").update(files.join("\n")).digest("hex") };
}

/** WHAT: Checks the exact native user event after submit. WHY: Keeps long wrapped TUI prompts and CLI setup records out of delivery truth. */
export function geminiPromptAccepted(prompt, { cursor, ...options } = {}) {
  if (!cursor || cursor.kind !== GEMINI_CURSOR_KIND || cursor.sessionId !== options.sessionId) return false;
  return hasJsonlEventAfterCursor(filesFor(options), cursor, event => userText(event) === prompt?.trim());
}

/** WHAT: Reads only the newest root user event. WHY: Gives tmux mirroring a stable turn identity without reading answers from the journal. */
export function latestGeminiPrompt(options) {
  const users = filesFor(options).flatMap(file => readWindow(file, { maxBytes: 4 * 1024 * 1024 }).events
    .flatMap(event => userText(event) ? [{ id: event.id, timestamp: event.timestamp, text: userText(event) }] : []));
  return users.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp))).at(-1) || null;
}
