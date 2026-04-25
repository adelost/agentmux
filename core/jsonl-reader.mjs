// Read Claude Code's session jsonl as the source of truth for responses.
//
// Claude Code writes every interaction to ~/.claude/projects/{encoded-dir}/{uuid}.jsonl
// as a stream of JSON events. Each line is one event: user message, assistant
// message, system hook, file snapshot, etc. The assistant messages contain
// structured content arrays with text (including code fences), tool_use entries,
// and thinking blocks. *Exactly* what Claude produced, before any UI rendering
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
  // Array content in a user event usually means tool_result, not a prompt
  return null;
}

// stop_reasons that mean "claude is done with this turn".
//
// IMPORTANT: max_tokens is NOT terminal in agentic Claude Code. When claude
// hits its per-message output budget mid-thought, it stops with max_tokens
// and then immediately continues in a fresh assistant message. Same turn,
// same user prompt. Treating max_tokens as terminal causes agentmux to bail
// halfway through long turns (observed on the "plocka ut" turn: extract
// grabbed 14 items when the real turn had 20+ and ended with end_turn).
//
// Anything NOT in this set means claude is still working:
//   null / undefined  = streaming in progress
//   "tool_use"        = pausing for a tool result
//   "max_tokens"      = budget hit, will continue automatically
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
 * Reliable echo-confirmation signal. No pane width or wordwrap involved.
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
 * attachment events). Used for walking forward over turn events.
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
  // Break when we hit a *new* user prompt (not a tool_result). That's the
  // start of the next turn.
  let lastAssistant = null;
  let pendingToolResult = false;
  let nextTurnExists = false;

  for (let i = userIdx + 1; i < events.length; i++) {
    const e = events[i];
    if (e.type === "user") {
      if (userPromptText(e) !== null) { nextTurnExists = true; break; }
      // Otherwise it's a tool_result. Claude will respond with a new
      // assistant message; until that arrives, we're still busy.
      pendingToolResult = true;
      continue;
    }
    if (e.type !== "assistant") continue;
    lastAssistant = e;
    pendingToolResult = false;
  }

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
        const mtime = statSync(found.jsonl).mtimeMs;
        if (Date.now() - mtime > 15_000) return false;
      } catch {
        // stat failed, can't determine staleness, stay busy
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
      // thinking, reasoning, etc. Skipped on purpose
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

// ---------------------------------------------------------------------------
// Multi-turn reader for `amux log` and similar history-display commands.
// Unlike extractFromJsonl (single last turn, optionally matched to a prompt),
// this walks all turns in the latest jsonl file and returns structured turns.

/** Parse a --since argument. Accepts ISO ("2026-04-22T10:00:00Z") or
 *  relative forms ("30min", "2h", "1d"). Returns a Date, or null on parse
 *  failure (caller treats null as "no filter"). */
export function parseSinceArg(arg) {
  if (!arg || typeof arg !== "string") return null;
  // Try ISO first
  const iso = new Date(arg);
  if (!Number.isNaN(iso.getTime())) return iso;
  // Relative: number + unit
  const m = arg.match(/^(\d+(?:\.\d+)?)\s*(s|sec|m|min|h|hr|d|day)s?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const ms = unit.startsWith("s") ? n * 1000
    : unit.startsWith("m") && unit !== "h" ? n * 60_000
    : unit.startsWith("h") ? n * 3_600_000
    : unit.startsWith("d") ? n * 86_400_000
    : 0;
  if (ms === 0) return null;
  return new Date(Date.now() - ms);
}

/**
 * Group events into turns. A turn starts at a type:"user" event with string
 * content (not a tool_result) and ends at the next such event. Assistant
 * and tool_result events between go into the turn.
 */
function groupIntoTurns(events) {
  const turns = [];
  let current = null;
  for (const e of events) {
    if (e.type === "user" && typeof e.message?.content === "string") {
      if (current) turns.push(current);
      current = {
        timestamp: e.timestamp || null,
        userPrompt: e.message.content,
        items: [],
      };
      continue;
    }
    if (!current) continue;
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type === "text" && typeof block.text === "string") {
          const text = block.text.trim();
          if (text) current.items.push({ type: "text", content: text });
        } else if (block.type === "tool_use") {
          current.items.push({ type: "tool", content: formatJsonlToolCall(block) });
        }
      }
    }
  }
  if (current) turns.push(current);

  // Merge adjacent text items within each turn (same reason as extractFromJsonl)
  for (const turn of turns) {
    const merged = [];
    for (const item of turn.items) {
      const last = merged[merged.length - 1];
      if (last && last.type === "text" && item.type === "text") {
        last.content = last.content + "\n\n" + item.content;
      } else {
        merged.push({ ...item });
      }
    }
    turn.items = merged;
  }
  return turns;
}

/**
 * Read the last N turns from the most-recent jsonl in a paneDir.
 *
 * @param {string} paneDir - The pane's cwd
 * @param {object} [opts]
 * @param {number} [opts.limit=3]  - Max turns to return (most recent first-in-order)
 * @param {Date|null} [opts.since] - Only turns at or after this time
 * @param {RegExp|null} [opts.grep] - Only turns whose userPrompt OR any item matches
 * @returns {{ turns: Array<object>, jsonlFile: string } | null}
 *   null when paneDir has no jsonl store (caller should fall back to tmux).
 */
export function readLastTurns(paneDir, opts = {}) {
  const { limit = 3, since = null, grep = null } = opts;
  const projectDir = join(CLAUDE_PROJECTS_DIR(), encodePath(paneDir));
  if (!existsSync(projectDir)) return null;
  const files = listJsonlFiles(projectDir);
  if (files.length === 0) return null;

  const events = parseJsonl(files[0].path);
  let turns = groupIntoTurns(events);

  if (since) {
    turns = turns.filter((t) => {
      if (!t.timestamp) return true; // keep if no timestamp (shouldn't happen but be lenient)
      const d = new Date(t.timestamp);
      return !Number.isNaN(d.getTime()) && d >= since;
    });
  }

  if (grep) {
    turns = turns.filter((t) => {
      if (grep.test(t.userPrompt)) return true;
      return t.items.some((i) => grep.test(i.content));
    });
  }

  if (turns.length > limit) turns = turns.slice(-limit);

  return { turns, jsonlFile: files[0].path };
}

// ---------------------------------------------------------------------------
// Cross-pane event stream for `amux timeline` and `amux watch`.
// Unlike readLastTurns (per-pane, grouped into turns), this reads every
// configured pane's jsonl store and returns a flat, merge-sorted stream of
// events so an orchestrator can follow all sessions in one view.

/** Project dir for a pane (where Claude Code stores the session jsonl). */
function projectDirFor(paneDir) {
  return join(CLAUDE_PROJECTS_DIR(), encodePath(paneDir));
}

/**
 * Latest jsonl file mtime for a pane in epoch ms, or null when no jsonl
 * exists. Cheap (single fs.stat per file in the project dir) — used by
 * ps to layer a "fresh activity" overlay on top of tmux-snapshot status,
 * since spinner-line patterns alone can't reliably distinguish active
 * thinking from post-turn residue.
 */
export function latestJsonlMtime(paneDir) {
  const projectDir = projectDirFor(paneDir);
  if (!existsSync(projectDir)) return null;
  const files = listJsonlFiles(projectDir);
  return files.length ? files[0].mtime : null;
}

/**
 * Flatten every jsonl event in a project dir to timeline rows.
 * Returns [{ timestamp, role, type, content, raw }] sorted by timestamp
 * ascending. Rows with missing timestamps get the file's mtime as fallback.
 * Only pulls from the newest jsonl in the project dir (the active session);
 * older files are from prior /clear or /compact rotations.
 */
function eventsFromProjectDir(projectDir) {
  if (!existsSync(projectDir)) return [];
  const files = listJsonlFiles(projectDir);
  if (files.length === 0) return [];
  const latest = files[0];
  const events = parseJsonl(latest.path);
  const rows = [];
  for (const e of events) {
    const ts = e.timestamp || null;
    if (e.type === "user" && typeof e.message?.content === "string") {
      rows.push({ timestamp: ts, role: "user", type: "text", content: e.message.content });
      continue;
    }
    if (e.type === "assistant" && Array.isArray(e.message?.content)) {
      for (const block of e.message.content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
          rows.push({ timestamp: ts, role: "assistant", type: "text", content: block.text.trim() });
        } else if (block.type === "tool_use") {
          rows.push({ timestamp: ts, role: "assistant", type: "tool", content: formatJsonlToolCall(block) });
        }
      }
    }
  }
  return rows;
}

/** Compute the cwd for a given pane of an agent (matches agent.mjs:paneDir). */
export function panePathFor(agent, paneIdx) {
  return join(agent.dir, ".agents", String(paneIdx));
}

/**
 * Read every pane's jsonl, merge-sort by timestamp, filter, and limit.
 *
 * @param {object} opts
 * @param {Array<object>} opts.agents  - agents from listAgents(): { name, dir, panes }
 * @param {Date|null}     [opts.since] - only rows at or after this time
 * @param {string|null}   [opts.agent] - filter to one agent by name
 * @param {number|null}   [opts.pane]  - filter to one pane index (pairs with agent)
 * @param {RegExp|null}   [opts.grep]  - filter rows by content regex
 * @param {number|null}   [opts.limit] - cap to the most recent N after filtering
 * @returns {Array<{timestamp:string, agent:string, pane:number, role:string, type:string, content:string}>}
 */
export function readAllTurnsAcrossPanes(opts = {}) {
  const { agents = [], since = null, agent: agentFilter = null, pane: paneFilter = null, grep = null, limit = null } = opts;
  const out = [];

  for (const a of agents) {
    if (agentFilter && a.name !== agentFilter) continue;
    const panes = Array.isArray(a.panes) ? a.panes : [];
    for (let paneIdx = 0; paneIdx < panes.length; paneIdx++) {
      if (paneFilter != null && paneIdx !== paneFilter) continue;
      const paneDir = panePathFor(a, paneIdx);
      const rows = eventsFromProjectDir(projectDirFor(paneDir));
      for (const r of rows) {
        out.push({ ...r, agent: a.name, pane: paneIdx });
      }
    }
  }

  // Merge-sort by timestamp (null timestamps sink to the end).
  out.sort((x, y) => {
    const tx = x.timestamp ? Date.parse(x.timestamp) : Number.POSITIVE_INFINITY;
    const ty = y.timestamp ? Date.parse(y.timestamp) : Number.POSITIVE_INFINITY;
    return tx - ty;
  });

  let filtered = out;
  if (since) {
    filtered = filtered.filter((r) => {
      if (!r.timestamp) return false;
      const d = Date.parse(r.timestamp);
      return !Number.isNaN(d) && d >= since.getTime();
    });
  }
  if (grep) {
    filtered = filtered.filter((r) => grep.test(r.content));
  }
  if (typeof limit === "number" && limit > 0 && filtered.length > limit) {
    filtered = filtered.slice(-limit);
  }
  return filtered;
}

/**
 * Count turns written to the pane's jsonl after a given cutoff timestamp.
 *
 * Used for the Discord catch-up notice: when the user returns to a channel
 * and posts a message, the bridge checks how much activity happened in the
 * pane since the last time the channel saw a message. If count > 0 we post
 * a short info line before forwarding.
 *
 * Reverse-walks the newest jsonl file for the pane and stops at the first
 * user-event with timestamp ≤ cutoff. Caps at 51 (caller renders "50+").
 *
 * @param {string} paneDir - The pane's cwd (e.g. panePathFor(agent, 1))
 * @param {string|Date|null} sinceTs - ISO string or Date; null = no cutoff (count all)
 * @returns {{ count: number, latest: string|null, capped: boolean } | null}
 *   null when no jsonl exists for the pane (fail silent — caller skips notice)
 */
export function countTurnsSince(paneDir, sinceTs) {
  const projectDir = projectDirFor(paneDir);
  if (!existsSync(projectDir)) return null;
  const files = listJsonlFiles(projectDir);
  if (files.length === 0) return null;

  let cutoffMs = null;
  if (sinceTs) {
    const d = typeof sinceTs === "string" ? new Date(sinceTs) : sinceTs;
    if (d instanceof Date && !Number.isNaN(d.getTime())) cutoffMs = d.getTime();
  }

  // Forward-read the file (jsonl is small enough in practice), then
  // reverse-iterate to short-circuit once we pass the cutoff. Malformed
  // lines are already filtered by parseJsonl.
  const events = parseJsonl(files[0].path);
  let count = 0;
  let latest = null;
  let capped = false;

  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!(e?.type === "user" && typeof e.message?.content === "string")) continue;
    if (!e.timestamp) continue;
    const t = Date.parse(e.timestamp);
    if (Number.isNaN(t)) continue;
    if (cutoffMs !== null && t <= cutoffMs) break; // hit the cutoff, stop
    count++;
    if (!latest) latest = e.timestamp; // first hit in reverse = newest
    if (count >= 51) { capped = true; break; }
  }

  return { count, latest, capped };
}

/**
 * Find the timestamp of the most recent compact summary in the pane's
 * newest jsonl file. Returns null if no compact event exists (pane never
 * /compact'ed since session start) or jsonl is missing.
 *
 * Compact events are user-role rows with `isCompactSummary: true`. Reverse
 * scan the newest file and return first match.
 *
 * Used by the drift-guard poll: when we see a compact newer than our
 * stored `lastCompactTsMs`, reset the turn counter because /compact
 * reloads CLAUDE.md as system context with full prominence again.
 *
 * @param {string} paneDir - The pane's cwd
 * @returns {number|null} epoch ms of latest compact, or null
 */
export function findLatestCompactTs(paneDir) {
  const projectDir = projectDirFor(paneDir);
  if (!existsSync(projectDir)) return null;
  const files = listJsonlFiles(projectDir);
  if (files.length === 0) return null;

  const events = parseJsonl(files[0].path);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.isCompactSummary !== true) continue;
    if (!e.timestamp) continue;
    const t = Date.parse(e.timestamp);
    if (Number.isFinite(t)) return t;
  }
  return null;
}
