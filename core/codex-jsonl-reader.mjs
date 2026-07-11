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

import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync, fstatSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { describeCustomExec, describeToolCall } from "./tool-display.mjs";

const CODEX_SESSIONS_DIR = () => join(process.env.HOME, ".codex", "sessions");

// Content-addressed line identity for the watcher's posted-set dedupe. Codex
// rollout events carry no stable id (no uuid, no payload.id), so we key on a
// hash of the raw JSON line. Like the Claude reader's uuid, a whole line is
// either fully inside the tail window or fully dropped, never re-indexed, so
// the hash is invariant under the sliding window. Positional keys (turnStartMs
// + item index) are FORBIDDEN in watcher state: both drift as the window slides
// and cause the final text to be skipped or double-posted.
function hashLine(line) {
  return createHash("sha1").update(line).digest("hex").slice(0, 16);
}
function parseLineWithHash(line, out) {
  if (!line.trim()) return;
  try {
    const e = JSON.parse(line);
    e.__hash = hashLine(line);
    out.push(e);
  } catch { /* skip malformed */ }
}

// Cache session_meta payload by file path. session_meta is the first event
// in a rollout file and is immutable for the lifetime of the session, so we
// only re-parse when mtime changes (which it won't for cwd, but invalidates
// cleanly if the user edits the file e.g. to fix a wrong cwd). Without
// this, latestSessionFor() reads every jsonl file (potentially 23MB each,
// hundreds of them) on every poll tick — saturating the bridge at 90% CPU.
const sessionMetaCache = new Map(); // filePath → { mtimeMs, payload }

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

// A rollout past Node's max string length (~0x1fffffe8 ≈ 512 MB) can't be read
// whole (readFileSync throws "Cannot create a string longer than..."), so a file
// larger than this is parsed from a bounded newline-aligned tail window instead
// — same fix + cap as the Claude reader. No consumer needs the pre-window history.
const MAX_JSONL_WINDOW_BYTES = 128 * 1024 * 1024;

/** Parse all JSON events from a jsonl file, skipping malformed lines. */
function parseJsonl(filePath) {
  let size = 0;
  try { size = statSync(filePath).size; } catch { /* fall through to direct read */ }
  if (size > MAX_JSONL_WINDOW_BYTES) return parseJsonlTail(filePath, MAX_JSONL_WINDOW_BYTES);
  try {
    const content = readFileSync(filePath, "utf-8");
    const events = [];
    for (const line of content.split("\n")) parseLineWithHash(line, events);
    return events;
  } catch {
    return [];
  }
}

/**
 * Parse only the last `maxBytes` of a Codex rollout. Watcher callers only
 * need the newest few turns, and rollout files can grow large during long
 * sessions. Like the Claude reader, this drops the partial leading line and
 * parses complete trailing JSONL events.
 */
function parseJsonlTail(filePath, maxBytes) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    if (size <= maxBytes) return parseJsonl(filePath);
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, size - maxBytes);
    let text = buf.toString("utf-8");
    const nl = text.indexOf("\n");
    if (nl !== -1) text = text.slice(nl + 1);
    return parseJsonlText(text);
  } catch {
    try { return parseJsonl(filePath); } catch { return []; }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

function parseJsonlText(content) {
  const events = [];
  for (const line of String(content || "").split("\n")) parseLineWithHash(line, events);
  return events;
}

// Session_meta lives on line 1 of every rollout. In real codex sessions it
// includes payload.instructions which can run 21-34KB. Read in 64KB chunks
// until we hit a newline, capping at 256KB as a sanity ceiling — anything
// larger would mean the file isn't a codex rollout. With cache hits dominating
// after the first sweep, the worst-case "scan all 186 sessions" cost is ~12MB
// of disk reads once, vs the old 290MB per poll-tick.
const SESSION_META_CHUNK = 64 * 1024;
const SESSION_META_CAP = 256 * 1024;

/**
 * Read just the session_meta event from a file. session_meta is always the
 * FIRST line in a codex rollout, but its payload.instructions field can push
 * line 1 past 30KB. Read incrementally until we find the newline (or hit cap)
 * instead of mapping the entire (potentially 23MB) file.
 *
 * Cached by (path, mtime) so subsequent polls hit memory unless the file's
 * mtime changes — which the cwd field doesn't, since session_meta is written
 * once at session start and never rewritten.
 */
function readSessionMeta(filePath) {
  let mtimeMs;
  try { mtimeMs = statSync(filePath).mtimeMs; }
  catch { return null; }

  const cached = sessionMetaCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.payload;

  let payload = null;
  let fd = null;
  try {
    fd = openSync(filePath, "r");
    const chunks = [];
    let totalRead = 0;
    let firstLine = null;

    while (totalRead < SESSION_META_CAP) {
      const buf = Buffer.alloc(SESSION_META_CHUNK);
      const bytesRead = readSync(fd, buf, 0, SESSION_META_CHUNK, totalRead);
      if (bytesRead === 0) break; // EOF
      chunks.push(buf.subarray(0, bytesRead));
      totalRead += bytesRead;

      // Concat-and-search is O(totalRead) per iteration but bounded by cap;
      // simpler than tracking newline scan position across chunks.
      const head = Buffer.concat(chunks).toString("utf-8");
      const newlineIdx = head.indexOf("\n");
      if (newlineIdx !== -1) {
        firstLine = head.slice(0, newlineIdx);
        break;
      }
      if (bytesRead < SESSION_META_CHUNK) break; // partial chunk = EOF, no newline
    }

    if (firstLine && firstLine.trim()) {
      try {
        const event = JSON.parse(firstLine);
        if (event.type === "session_meta") payload = event.payload;
      } catch { /* malformed first line — leave payload null */ }
    }
  } catch { /* fd open failed, leave payload null */ }
  finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* swallow */ } }
  }

  sessionMetaCache.set(filePath, { mtimeMs, payload });
  return payload;
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
  return describeCodexToolCall(payload).content;
}

function describeCodexToolCall(payload) {
  if (payload?.type === "custom_tool_call" && payload.name === "exec") {
    return describeCustomExec(payload.input);
  }
  let input = payload?.input || {};
  if (payload?.arguments != null) {
    try { input = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments; }
    catch { input = {}; }
  }
  return describeToolCall(payload?.name || "tool", input);
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
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const display = describeCodexToolCall(p);
      items.push({
        type: "tool",
        content: display.content,
        kind: display.kind,
        source: p.type === "custom_tool_call" ? "custom" : "function",
      });
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

/**
 * Latest codex session jsonl file matching a paneDir, or null when none.
 * Public wrapper around the internal latestSessionFor() so the watcher can
 * dispatch fs.watch + freshness checks against the right file.
 */
export function latestCodexSessionFor(paneDir) {
  return latestSessionFor(paneDir);
}

/**
 * Latest codex jsonl mtime for a pane in epoch ms, or null when no
 * matching session exists. Cheap, single fs.stat. Mirrors the claude
 * latestJsonlMtime() helper so the watcher's freshness/grace logic can be
 * dialect-dispatched without if-claude/else-codex sprinkled everywhere.
 */
export function latestCodexJsonlMtime(paneDir) {
  const file = latestSessionFor(paneDir);
  if (!file) return null;
  try { return statSync(file).mtimeMs; }
  catch { return null; }
}

/**
 * Latest matching Codex rollout identity for a pane, or null when none exists.
 *
 * WHAT: Cheap-enough file stamp used before parsing rollout tails.
 * WHY: Watcher polls many panes; unchanged path, mtime, and size means the
 *      append-only rollout has no new mirrorable events, so callers can avoid
 *      the bounded tail read. latestSessionFor() still resolves the matching
 *      rollout; caching that index is a separate optimization.
 */
export function latestCodexJsonlInfo(paneDir) {
  const file = latestSessionFor(paneDir);
  if (!file) return null;
  try {
    const st = statSync(file);
    return { path: file, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  }
}

/**
 * Group codex events into the same turn-shape readLastTurns() returns for
 * Claude, so the jsonl-watcher can drive the post pipeline dialect-agnostic.
 *
 * Turn boundaries:
 *   - event_msg:user_message starts a new turn (carries timestamp + prompt)
 *   - response_item:message (role=assistant) text blocks → text items
 *   - response_item:function_call → tool items (Discord sees tool-only progress)
 *   - event_msg:task_complete → isComplete=true + endTimestamp captured
 *   - reasoning events skipped (same as Claude thinking blocks)
 *
 * Adjacent text items merged with double-newline separator (same as Claude).
 *
 * @returns {Array<{
 *   timestamp: string|null,
 *   userPrompt: string,
 *   items: Array<{type:"text"|"tool", content:string}>,
 *   endTimestamp: string|null,
 *   isComplete: boolean,
 *   turnId: string|null,
 * }>}
 */
function groupCodexIntoTurns(events, { headless = false } = {}) {
  const turns = [];
  let current = null;
  // A busy Codex task can receive several user_message events before its one
  // task_complete event. Keep that task identity active across every logical
  // prompt segment; treating it as a one-shot "pending" id leaves the final
  // segment incomplete and makes the watcher lose its narrative on restart.
  let activeTaskId = null;
  // Map turn_id → the latest logical segment. task_complete closes the segment
  // that can still receive output, not the first prompt seen for that task.
  const byTurnId = new Map();

  for (const e of events) {
    if (e.type === "event_msg" && e.payload?.type === "task_started") {
      const turnId = e.payload.turn_id || null;
      if (turnId && current && !current.turnId && !current.isComplete && current.items.length === 0) {
        current.turnId = turnId;
        byTurnId.set(turnId, current);
      }
      activeTaskId = turnId;
      continue;
    }
    if (e.type === "turn_context" && e.payload?.turn_id) {
      // Codex repeats turn_context after an in-task /compact. It may also be
      // the first lifecycle event inside a bounded tail read, so it is a valid
      // source for restoring the active task identity.
      activeTaskId = e.payload.turn_id;
      if (current && !current.isComplete && !current.turnId) {
        current.turnId = activeTaskId;
        byTurnId.set(activeTaskId, current);
      }
      continue;
    }
    if (e.type === "event_msg" && e.payload?.type === "user_message") {
      if (current) {
        // The next prompt is a hard parser boundary: subsequent response items
        // cannot be attributed to the prior segment. Mark a non-empty segment
        // settled even though the enclosing Codex task remains active.
        if (current.items.length > 0) current.isComplete = true;
        turns.push(current);
      }
      const turnId = activeTaskId;
      current = {
        timestamp: e.timestamp || null,
        userPrompt: e.payload.message ?? "",
        items: [],
        endTimestamp: null,
        isComplete: false,
        turnId,
      };
      if (turnId) byTurnId.set(turnId, current);
      continue;
    }
    if (e.type === "event_msg" && e.payload?.type === "task_complete") {
      const target = byTurnId.get(e.payload.turn_id) || current;
      if (target) {
        // Race: codex sometimes flushes task_complete to jsonl before the
        // response_item:message that carries the assistant's text. If we
        // set isComplete=true with an empty items array, the watcher's
        // "items=0 + isComplete=true" branch reads it as "fully posted,
        // advance checkpoint" and silently swallows the reply. Defer the
        // complete signal until items have actually landed; flag it for
        // the final pass to apply once we know whether items materialized.
        target._sawTaskComplete = true;
        if (e.timestamp) target.endTimestamp = e.timestamp;
      }
      if (activeTaskId === e.payload.turn_id) activeTaskId = null;
      continue;
    }
    if (e.type === "response_item" && !current && headless) {
      const p = e.payload;
      const isNarrative = p?.type === "message" && p.role === "assistant" && Array.isArray(p.content);
      if (isNarrative || p?.type === "function_call") {
        // A bounded tail can begin after the user_message marker when image or
        // tool output lines are huge. Reconstruct the visible suffix instead
        // of dropping a final answer merely because its prompt scrolled out.
        current = {
          timestamp: e.timestamp || null,
          userPrompt: "",
          items: [],
          endTimestamp: null,
          isComplete: false,
          turnId: activeTaskId,
        };
        if (activeTaskId) byTurnId.set(activeTaskId, current);
      }
    }
    if (e.type !== "response_item" || !current) continue;
    const p = e.payload;
    if (!p) continue;

    if (p.type === "message" && p.role === "assistant" && Array.isArray(p.content)) {
      p.content.forEach((block, blockIndex) => {
        if (block.type === "output_text" && typeof block.text === "string") {
          const text = block.text.trim();
          if (text) current.items.push({ type: "text", content: text, id: codexItemId(e.__hash, blockIndex) });
        }
      });
      if (e.timestamp) current.endTimestamp = e.timestamp;
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      const display = describeCodexToolCall(p);
      current.items.push({
        type: "tool",
        content: display.content,
        kind: display.kind,
        source: p.type === "custom_tool_call" ? "custom" : "function",
        id: codexItemId(e.__hash, 0),
      });
      if (e.timestamp) current.endTimestamp = e.timestamp;
    }
    // p.type === "reasoning" → intentionally skipped (mirrors Claude thinking blocks)
  }
  if (current) turns.push(current);

  // Final pass: apply task_complete signal only when items actually
  // landed. Strips the internal `_sawTaskComplete` flag so the public
  // turn shape stays clean. Turns that saw task_complete but no items
  // are left as isComplete=false — the watcher's grace path will pick
  // them up later if items eventually arrive (or correctly post nothing
  // if the turn truly had empty assistant output, e.g. tool-only with
  // function_call but no text — handled by items.length > 0 below).
  for (const turn of turns) {
    if (turn._sawTaskComplete && turn.items.length > 0) {
      turn.isComplete = true;
    }
    delete turn._sawTaskComplete;
  }

  // Merge adjacent text items per turn. Keep the LAST constituent's id (see
  // hashLine): the tail window drops only leading events, so the last member of
  // a visible run is the last to scroll out — a stable dedupe key.
  for (const turn of turns) {
    const merged = [];
    for (const item of turn.items) {
      const last = merged[merged.length - 1];
      if (last && last.type === "text" && item.type === "text") {
        last.content = last.content + "\n\n" + item.content;
        last.id = item.id;
      } else {
        merged.push({ ...item });
      }
    }
    turn.items = merged;
  }
  return turns;
}

function codexItemId(hash, blockIndex) {
  return hash ? `${hash}:${blockIndex}` : null;
}

function codexCompactions(events) {
  return events
    .filter((e) => e.type === "compacted")
    .map((e) => ({ id: e.__hash || e.timestamp || null, timestamp: e.timestamp || null }))
    .filter((e) => e.id);
}

/**
 * Read the last N turns from the most-recent codex session matching paneDir.
 * Same shape + semantics as readLastTurns() in jsonl-reader.mjs so the
 * watcher can dispatch on dialect without branching the post pipeline.
 *
 * @param {string} paneDir - The pane's cwd
 * @param {object} [opts]
 * @param {number} [opts.limit=3]
 * @param {Date|null} [opts.since]
 * @param {RegExp|null} [opts.grep]
 * @returns {{ turns: Array<object>, jsonlFile: string } | null}
 */
export function readLastTurnsCodex(paneDir, opts = {}) {
  const { limit = 3, since = null, grep = null, tailBytes = null, headless = false } = opts;
  const file = latestSessionFor(paneDir);
  if (!file) return null;

  const events = (tailBytes && !since && !grep)
    ? parseJsonlTail(file, tailBytes)
    : parseJsonl(file);
  if (events.length === 0) return { turns: [], compactions: [], jsonlFile: file };

  let turns = groupCodexIntoTurns(events, { headless });
  const compactions = codexCompactions(events);

  if (since) {
    turns = turns.filter((t) => {
      if (!t.timestamp) return true;
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

  return { turns, compactions, jsonlFile: file };
}
