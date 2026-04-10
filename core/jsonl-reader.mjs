// Read Claude Code's session jsonl as the source of truth for responses.
//
// Claude Code writes every interaction to ~/.claude/projects/{encoded-dir}/{uuid}.jsonl
// as a stream of JSON events. Each line is one event: user message, assistant
// message, system hook, file snapshot, etc. The assistant messages contain
// structured content arrays with text (including code fences), tool_use entries,
// and thinking blocks — *exactly* what Claude produced, before any UI rendering
// stripped it down to indented plaintext for tmux.
//
// This module reads that structured data and returns items in the same shape
// as our tmux extract pipeline: [{ type: "text"|"tool", content: string }].
// Downstream code (handlers, recorder, Discord send) doesn't know the difference.

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";

const CLAUDE_PROJECTS_DIR = () => join(process.env.HOME, ".claude", "projects");

/**
 * Claude Code's path encoding: every `/` and `.` becomes a `-`.
 * Example: /home/adelost/lsrc/.agents/1 → -home-adelost-lsrc--agents-1
 */
function encodePath(dir) {
  return dir.replace(/[\/\.]/g, "-");
}

/** List jsonl files in a project dir, newest-first. */
function listJsonlFiles(projectDir) {
  if (!existsSync(projectDir)) return [];
  try {
    return readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const path = join(projectDir, f);
        return { path, mtime: statSync(path).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return [];
  }
}

/**
 * Find the jsonl file containing a given prompt, plus its parsed events.
 *
 * Claude Code starts a fresh jsonl file on /clear and /compact. If the user
 * runs either mid-turn, `latestJsonlFile` would return the new (empty) file
 * while our prompt is still sitting in the OLD file. Scanning all files
 * newest-first until one contains the needle survives that rotation.
 *
 * If no needle is given, returns the newest file (current behavior for
 * context/telemetry callers that don't care about a specific prompt).
 *
 * @returns { jsonl, events } or null if nothing matches
 */
function findJsonlAndEvents(projectDir, needle) {
  const files = listJsonlFiles(projectDir);
  if (files.length === 0) return null;

  if (!needle) {
    const events = parseJsonl(files[0].path);
    return { jsonl: files[0].path, events };
  }

  const needleTrim = needle.trim();
  for (const { path } of files) {
    const events = parseJsonl(path);
    for (const e of events) {
      const text = extractPromptFromEvent(e);
      if (text && text.trim() === needleTrim) return { jsonl: path, events };
    }
  }
  return null;
}

/** Parse every JSON line in a jsonl file, skipping malformed lines. */
function parseJsonl(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const events = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // skip malformed line
    }
  }
  return events;
}

/**
 * Extract the string user content from an event. Returns null if the content
 * is a tool_result array (which is technically a user event but contains tool
 * output rather than a new prompt) or missing.
 */
function userPromptText(event) {
  if (event?.type !== "user") return null;
  const content = event.message?.content;
  if (typeof content === "string") return content;
  // Array content in a user event usually means tool_result — not a prompt
  return null;
}

// stop_reasons that mean "claude is done with this turn".
//
// IMPORTANT: max_tokens is NOT terminal in agentic Claude Code. When claude
// hits its per-message output budget mid-thought, it stops with max_tokens
// and then immediately continues in a fresh assistant message — same turn,
// same user prompt. Treating max_tokens as terminal causes agentus to bail
// halfway through long turns (observed on the "plocka ut" turn: extract
// grabbed 14 items when the real turn had 20+ and ended with end_turn).
//
// Anything NOT in this set means claude is still working:
//   null / undefined  — streaming in progress
//   "tool_use"        — pausing for a tool result
//   "max_tokens"      — budget hit, will continue automatically
const TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "refusal"]);

/**
 * Extract any prompt-like text from a single jsonl event. Claude Code records
 * the same prompt in several places depending on timing:
 *
 *   { type: "user", message: { content: "..." } }            // direct user event
 *   { type: "queue-operation", operation: "enqueue",         // sent while busy
 *     content: "..." }
 *   { type: "attachment", attachment: { type: "queued_command",
 *     prompt: "..." } }                                       // queue ack
 *
 * All three are legitimate "agent received the prompt" signals.
 */
function extractPromptFromEvent(event) {
  if (!event) return null;
  if (event.type === "user" && typeof event.message?.content === "string") {
    return event.message.content;
  }
  if (event.type === "queue-operation" && event.operation === "enqueue" && typeof event.content === "string") {
    return event.content;
  }
  if (event.type === "attachment" && event.attachment?.type === "queued_command" && typeof event.attachment.prompt === "string") {
    return event.attachment.prompt;
  }
  return null;
}

/**
 * Check if a given prompt has been written to Claude's jsonl for this pane.
 * Reliable echo-confirmation signal — no pane width or wordwrap involved.
 * Matches user events, queue-operations, and attachment queue-acks.
 *
 * @returns boolean or null (no jsonl file → caller should fall back)
 */
export function isPromptInJsonl(paneDir, promptText) {
  const needle = promptText?.trim();
  if (!needle) return null;

  const projectDir = join(CLAUDE_PROJECTS_DIR(), encodePath(paneDir));
  if (!existsSync(projectDir) || listJsonlFiles(projectDir).length === 0) return null;

  // findJsonlAndEvents scans all files newest-first for the needle, so it
  // returns non-null iff some file contains the prompt.
  return findJsonlAndEvents(projectDir, needle) !== null;
}

/**
 * Find the index of the last user event whose prompt text matches the needle.
 * Only matches type:user events (real turn starts, not queue-operation or
 * attachment events) — used for walking forward over turn events.
 *
 * Strict matching: if a needle is given and no type:user event matches,
 * return -1. No fallback to "last user prompt" (could be another agent's).
 */
function findUserPromptIndex(events, promptText) {
  const needle = promptText?.trim();
  if (needle) {
    for (let i = events.length - 1; i >= 0; i--) {
      const text = userPromptText(events[i]);
      if (text && text.trim() === needle) return i;
    }
    return -1;
  }
  for (let i = events.length - 1; i >= 0; i--) {
    if (userPromptText(events[i]) !== null) return i;
  }
  return -1;
}

/**
 * True if the prompt appears anywhere in events (user, queue-operation,
 * attachment). Uses extractPromptFromEvent so all three shapes match.
 */
function promptAppearsInEvents(events, promptText) {
  const needle = promptText?.trim();
  if (!needle) return false;
  for (const e of events) {
    const text = extractPromptFromEvent(e);
    if (text && text.trim() === needle) return true;
  }
  return false;
}

/**
 * Format a tool_use block into a compact one-line string suitable for Discord.
 * Claude: { name: "Bash", input: { command: "ls" } } → "Bash ls"
 */
export function formatJsonlToolCall(toolUse) {
  const { name = "Tool", input = {} } = toolUse;

  if (name === "Bash") {
    const cmd = String(input.command || "");
    return `Bash ${cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd}`;
  }

  if (name === "Read" || name === "Write" || name === "Edit") {
    const path = String(input.file_path || input.path || "");
    const parts = path.split("/");
    const short = parts.length > 3 ? ".../" + parts.slice(-2).join("/") : path;
    return `${name} ${short}`;
  }

  if (name === "Glob" || name === "Grep") {
    const pat = String(input.pattern || "");
    return `${name} ${pat.length > 60 ? pat.slice(0, 57) + "..." : pat}`;
  }

  if (name === "Task" || name === "Agent") {
    const sub = input.subagent_type || input.description || "";
    return `${name} ${sub}`;
  }

  // Generic fallback: show first 1-2 args compactly
  const entries = Object.entries(input).slice(0, 2);
  const args = entries
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`)
    .join(" ");
  return args ? `${name} ${args}` : name;
}

/**
 * Determine whether Claude is busy for a given pane, using the session jsonl
 * as source of truth instead of parsing the tmux pane text.
 *
 * Claude writes every event to ~/.claude/projects/{encoded}/{session}.jsonl
 * including the final assistant message with a stop_reason field. If the most
 * recent assistant event for our turn has a terminal stop_reason
 * (end_turn / stop_sequence / max_tokens / refusal) and there is nothing
 * pending after it, the agent is idle. Everything else means it's still
 * working (streaming, tool_use pausing for a result, etc).
 *
 * @param {string} paneDir - The pane's working dir (e.g. ~/lsrc/.agents/1)
 * @param {string|null} promptText - Our user prompt; used to anchor the walk
 * @returns {boolean | null}
 *   true  = claude is busy
 *   false = claude is idle (turn complete)
 *   null  = can't tell (no jsonl, no matching prompt) → caller should fall back
 */
export function isBusyFromJsonl(paneDir, promptText = null) {
  const projectDir = join(CLAUDE_PROJECTS_DIR(), encodePath(paneDir));
  const found = findJsonlAndEvents(projectDir, promptText);
  if (!found) {
    // No file contains the needle. Two subcases:
    //   1. No jsonl files at all → null (caller falls back)
    //   2. Files exist but needle isn't in any of them → could mean the
    //      prompt is still queued in a newer file as queue-operation, so
    //      check the latest file for that case.
    if (listJsonlFiles(projectDir).length === 0) return null;
    if (!promptText) return null;
    const latest = findJsonlAndEvents(projectDir, null);
    if (!latest) return null;
    if (promptAppearsInEvents(latest.events, promptText)) return true;
    return null;
  }

  const { events } = found;
  if (events.length === 0) return null;

  const userIdx = findUserPromptIndex(events, promptText);
  if (userIdx === -1) {
    // File contained the needle as a queue-operation / attachment but not
    // as a type:user event → claude hasn't started our turn yet → busy.
    if (promptText && promptAppearsInEvents(events, promptText)) return true;
    return null;
  }

  // Walk forward from the user prompt, tracking the last assistant event.
  // Break when we hit a *new* user prompt (not a tool_result) — that's the
  // start of the next turn.
  let lastAssistant = null;
  let pendingToolResult = false;
  let nextTurnExists = false;

  for (let i = userIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === "user") {
      if (userPromptText(e) !== null) { nextTurnExists = true; break; }
      // Otherwise it's a tool_result — claude will respond with a new
      // assistant message; until that arrives, we're still busy.
      pendingToolResult = true;
      continue;
    }
    if (e.type !== "assistant") continue;
    lastAssistant = e;
    pendingToolResult = false;
  }

  // If a later user prompt exists in the jsonl, claude accepted new input
  // which proves our turn finished — regardless of what stop_reason says.
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
        const mtime = statSync(found.jsonl).mtimeMs;
        if (Date.now() - mtime > 15_000) return false;
      } catch {
        // stat failed — can't determine staleness, stay busy
      }
    }
  }

  // null / "tool_use" / missing / unknown → still working
  return true;
}

/**
 * Extract items (text + tool calls) from the last assistant response
 * matching a specific user prompt.
 *
 * @param {string} paneDir - The pane's working dir (e.g. ~/lsrc/.agents/1)
 * @param {string|null} promptText - User prompt text to match against
 * @returns {{ items: Array<{type:"text"|"tool", content:string}>, raw: string, turn: string } | null}
 *
 * Returns null if no jsonl exists for this paneDir or if no matching turn
 * is found. Callers should fall back to tmux extract in that case.
 */
export function extractFromJsonl(paneDir, promptText = null) {
  const projectDir = join(CLAUDE_PROJECTS_DIR(), encodePath(paneDir));
  const found = findJsonlAndEvents(projectDir, promptText);
  if (!found) return null;

  const { jsonl, events } = found;
  if (events.length === 0) return null;

  const userIdx = findUserPromptIndex(events, promptText);
  if (userIdx === -1) return null;

  // Walk forward from the user event, collecting assistant content until
  // we hit the next real user prompt (tool_result user events are skipped).
  const items = [];
  for (let i = userIdx + 1; i < events.length; i++) {
    const e = events[i];

    if (e.type === "user") {
      // Tool-result user events don't end the turn; real new prompts do.
      if (userPromptText(e) !== null) break;
      continue;
    }

    if (e.type !== "assistant") continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        const text = block.text.trim();
        if (text) items.push({ type: "text", content: text });
      } else if (block.type === "tool_use") {
        items.push({ type: "tool", content: formatJsonlToolCall(block) });
      }
      // thinking, reasoning, etc — skipped on purpose
    }
  }

  if (items.length === 0) return null;

  // Merge adjacent text items (Claude sometimes splits a response into
  // multiple assistant events without tool calls between them)
  const merged = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (last && last.type === "text" && item.type === "text") {
      last.content = last.content + "\n\n" + item.content;
    } else {
      merged.push({ ...item });
    }
  }

  // Synthesize a raw/turn string for recording. Not used for re-extract.
  const raw = merged.map((i) => (i.type === "tool" ? `[tool] ${i.content}` : i.content)).join("\n\n");

  return { items: merged, raw, turn: raw, source: "jsonl", jsonlFile: jsonl };
}
