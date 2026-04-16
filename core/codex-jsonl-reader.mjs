// Read Codex's session rollout files as the source of truth for responses.
//
// Codex writes every session to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
// as a stream of JSON events:
//   - session_meta   (payload.cwd identifies which workspace)
//   - event_msg      (task_started, task_complete, user_message, agent_message,
//                     token_count, reasoning, function_call, exec_command_end)
//   - response_item  (message with role=user/assistant/developer,
//                     function_call with name+arguments)
//
// Busy detection uses the task_started/task_complete turn_id pair. Content
// extraction uses response_item 'message' events with role=assistant plus
// function_call events.

import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join } from "path";

const CODEX_SESSIONS_DIR = () => join(process.env.HOME, ".codex", "sessions");

/** Walk a directory tree (bounded depth) and return all .jsonl file paths. */
function findJsonlFiles(dir, depth = 0, acc = []) {
  if (depth > 4 || !existsSync(dir)) return acc;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) findJsonlFiles(path, depth + 1, acc);
    else if (e.name.endsWith(".jsonl")) acc.push(path);
  }
  return acc;
}

/** Parse all JSON events from a jsonl file, skipping malformed lines. */
function parseJsonl(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    const events = [];
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); }
      catch { /* skip */ }
    }
    return events;
  } catch {
    return [];
  }
}

/** Read just the session_meta event (first line, usually) from a file. */
function readSessionMeta(filePath) {
  try {
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "session_meta") return event.payload;
      } catch { /* skip */ }
      break; // only check first few lines
    }
  } catch {}
  return null;
}

/**
 * Find the most specific codex rollout file matching a pane dir.
 *
 * Codex records `cwd` at session start. A pane may cd into subdirs later,
 * but the session file stays the same. Matching rules (in priority order):
 *
 *   1. Exact cwd == paneDir (most reliable)
 *   2. cwd is an ancestor of paneDir (pane cd'd deeper since start)
 *
 * When multiple ancestors match (e.g. both /foo and /foo/bar have sessions
 * for paneDir /foo/bar/sub), prefer the *closest* ancestor, the one with
 * the longest cwd prefix. That's the session that actually started in the
 * pane's directory tree, not some unrelated codex running in /foo.
 *
 * Ties on specificity break to newest mtime.
 *
 * We deliberately do NOT match sessions whose cwd is a *descendant* of
 * paneDir (e.g. paneDir=/foo/bar, cwd=/foo/bar/sub). That would pick up
 * any codex running inside our workspace, not our pane's own codex.
 */
function latestSessionFor(paneDir) {
  const base = CODEX_SESSIONS_DIR();
  const files = findJsonlFiles(base)
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }));

  const candidates = [];
  for (const { path, mtime } of files) {
    const meta = readSessionMeta(path);
    const cwd = meta?.cwd;
    if (!cwd) continue;
    if (paneDir === cwd) {
      candidates.push({ path, mtime, specificity: cwd.length, exact: true });
    } else if (paneDir.startsWith(cwd + "/")) {
      candidates.push({ path, mtime, specificity: cwd.length, exact: false });
    }
  }

  if (candidates.length === 0) return null;

  // Priority: exact > longest prefix > newest mtime
  candidates.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    return b.mtime - a.mtime;
  });

  return candidates[0].path;
}

/**
 * Check if a given prompt has been written to Codex's rollout jsonl for
 * this pane. Echo confirmation via data, not tmux pane text.
 *
 * @returns boolean (true = prompt found) or null (no session file)
 */
export function isPromptInCodexJsonl(paneDir, promptText) {
  const needle = promptText?.trim();
  if (!needle) return null;

  const file = latestSessionFor(paneDir);
  if (!file) return null;

  const events = parseJsonl(file);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "event_msg") continue;
    if (e.payload?.type !== "user_message") continue;
    if (e.payload.message === needle) return true;
  }
  return false;
}

/**
 * Check if Codex is busy for a given pane.
 *
 * @returns {boolean | null}
 *   true  = busy (task_started without matching task_complete)
 *   false = idle (all task_started turns have a task_complete)
 *   null  = unknown (no session file found, caller should fall back)
 */
export function isBusyFromCodexJsonl(paneDir) {
  const file = latestSessionFor(paneDir);
  if (!file) return null;

  const events = parseJsonl(file);
  if (events.length === 0) return null;

  // Track which turns have started vs completed
  const startedTurns = new Set();
  const completedTurns = new Set();

  for (const e of events) {
    if (e.type !== "event_msg") continue;
    const p = e.payload;
    if (p?.type === "task_started" && p.turn_id) startedTurns.add(p.turn_id);
    else if (p?.type === "task_complete" && p.turn_id) completedTurns.add(p.turn_id);
  }

  // If any started turn is not yet completed → busy
  for (const turnId of startedTurns) {
    if (!completedTurns.has(turnId)) return true;
  }
  return false;
}

/** Format a codex function_call into a compact one-liner. */
export function formatCodexToolCall(payload) {
  const { name = "tool", arguments: rawArgs = "" } = payload;
  let args = rawArgs;

  try {
    const parsed = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    if (name === "exec_command" && parsed.cmd) {
      const cmd = String(parsed.cmd);
      return `Bash ${cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd}`;
    }
    // Generic: show 1-2 primary args
    const keys = Object.keys(parsed).slice(0, 2);
    args = keys.map((k) => `${k}=${String(parsed[k]).slice(0, 40)}`).join(" ");
  } catch { /* fall through to raw args */ }

  return `${name}${args ? " " + args : ""}`;
}

/**
 * Find the [start, end) index range for the turn matching a prompt needle.
 *
 * Codex records each prompt as an `event_msg:user_message` event. Turn
 * boundaries are clean: after the user_message, response_item events flow
 * in, then `task_complete` closes the turn, then the next `task_started`
 * and `user_message` begin the following turn.
 *
 * Walking from user_message forward until the next user_message (or end)
 * gives us exactly one turn's worth of content. Matching on prompt text
 * survives the "two prompts in quick succession" race where the last
 * task_started isn't the one we sent.
 *
 * Returns null if no matching user_message exists.
 */
function findCodexTurnRange(events, promptText) {
  const needle = promptText?.trim();

  // With a needle: find the matching user_message (most recent match first).
  if (needle) {
    let startIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.type === "event_msg" && e.payload?.type === "user_message" && e.payload.message === needle) {
        startIdx = i;
        break;
      }
    }
    if (startIdx === -1) return null;

    // End: next user_message after startIdx, or end of events
    let endIdx = events.length;
    for (let i = startIdx + 1; i < events.length; i++) {
      const e = events[i];
      if (e.type === "event_msg" && e.payload?.type === "user_message") {
        endIdx = i;
        break;
      }
    }
    return { startIdx, endIdx };
  }

  // No needle: use the last user_message (same semantics as "last turn").
  // Falls back to last task_started for very early turns that haven't
  // produced a user_message event yet.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "event_msg" && e.payload?.type === "user_message") {
      return { startIdx: i, endIdx: events.length };
    }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "event_msg" && e.payload?.type === "task_started") {
      return { startIdx: i, endIdx: events.length };
    }
  }
  return null;
}

/**
 * Extract items from a codex turn.
 *
 * If promptText is given, returns the turn whose user_message matches that
 * text (necessary when a later prompt has already started. The last
 * task_started is no longer ours). Without a needle, returns the most
 * recent turn.
 *
 * Walks forward from the user_message collecting response_item:message
 * (assistant role) and response_item:function_call events in order, until
 * the next user_message or end of events. Returns { items, raw, turn,
 * source, jsonlFile }. Same shape as the Claude jsonl reader.
 */
export function extractFromCodexJsonl(paneDir, promptText = null) {
  const file = latestSessionFor(paneDir);
  if (!file) return null;

  const events = parseJsonl(file);
  if (events.length === 0) return null;

  const range = findCodexTurnRange(events, promptText);
  if (!range) return null;
  const { startIdx, endIdx } = range;

  const items = [];
  for (let i = startIdx + 1; i < endIdx; i++) {
    const e = events[i];
    if (e.type !== "response_item") continue;
    const p = e.payload;
    if (!p) continue;

    if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      for (const block of p.content) {
        if (block.type === "output_text" && typeof block.text === "string") {
          const text = block.text.trim();
          if (text) items.push({ type: "text", content: text });
        }
      }
    } else if (p.type === "function_call") {
      items.push({ type: "tool", content: formatCodexToolCall(p) });
    }
  }

  if (items.length === 0) return null;

  // Merge adjacent text items
  const merged = [];
  for (const item of items) {
    const last = merged[merged.length - 1];
    if (last && last.type === "text" && item.type === "text") {
      last.content = last.content + "\n\n" + item.content;
    } else {
      merged.push({ ...item });
    }
  }

  const raw = merged.map((i) => (i.type === "tool" ? `[tool] ${i.content}` : i.content)).join("\n\n");
  return { items: merged, raw, turn: raw, source: "codex-jsonl", jsonlFile: file };
}
