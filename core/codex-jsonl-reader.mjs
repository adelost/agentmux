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
import { dirname, join } from "path";
import { createHash } from "crypto";
import { describeCustomExec, describeToolCall } from "./tool-display.mjs";
import { codexSessionDirs } from "./codex-profiles.mjs";
import { captureJsonlAppendCursor, jsonlEventsAfterCursor } from "./jsonl-append-cursor.mjs";

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
// Delivery/busy checks only need the live tail. Reading a 128MB rollout on
// every 200ms echo poll made the bridge itself CPU-bound when several large
// Codex panes received messages together. Keep extraction's generous window,
// but give transport checks a small cached operational view.
const MAX_OPERATIONAL_WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_OPERATIONAL_CACHE_FILES = 8;
const operationalEventsCache = new Map(); // filePath → { mtimeMs, size, events }

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

function parseOperationalJsonl(filePath) {
  let stat;
  try { stat = statSync(filePath); } catch { return []; }
  const cached = operationalEventsCache.get(filePath);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    operationalEventsCache.delete(filePath);
    operationalEventsCache.set(filePath, cached);
    return cached.events;
  }
  const events = stat.size > MAX_OPERATIONAL_WINDOW_BYTES
    ? parseJsonlTail(filePath, MAX_OPERATIONAL_WINDOW_BYTES)
    : parseJsonl(filePath);
  operationalEventsCache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, events });
  while (operationalEventsCache.size > MAX_OPERATIONAL_CACHE_FILES) {
    operationalEventsCache.delete(operationalEventsCache.keys().next().value);
  }
  return events;
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
 *   1. Exact cwd == paneDir or a verified git worktree below it
 *   2. cwd is an ancestor of paneDir (pane cd'd deeper since start)
 *
 * When multiple ancestors match (e.g. both /foo and /foo/bar have sessions
 * for paneDir /foo/bar/sub), prefer the *closest* ancestor, the one with
 * the longest cwd prefix. That's the session that actually started in the
 * pane's directory tree, not some unrelated codex running in /foo.
 *
 * Ties on specificity break to newest mtime.
 *
 * Other descendant sessions remain rejected: only an on-disk `.git` marker
 * establishes that the pane intentionally started Codex in its worktree.
 */
function isPaneWorktreeCwd(paneDir, cwd) {
  if (!String(cwd).startsWith(`${paneDir}/`)) return false;
  let current = cwd;
  while (current !== paneDir && current.startsWith(`${paneDir}/`)) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function latestSessionFor(paneDir, { sessionDirs = codexSessionDirs() } = {}) {
  // Profile 1 remains ~/.codex; profile 2 has its own CODEX_HOME.  Search
  // both so switching accounts does not make the watcher/context layer lose
  // the pane's rollout just because its storage root changed.
  const files = sessionDirs.flatMap((base) => findJsonlFiles(base, 0, []))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }));

  const candidates = [];
  for (const { path, mtime } of files) {
    const meta = readSessionMeta(path);
    const cwd = meta?.cwd;
    if (!cwd) continue;
    if (paneDir === cwd) {
      candidates.push({ path, mtime, specificity: cwd.length, direct: true, exact: true });
    } else if (isPaneWorktreeCwd(paneDir, cwd)) {
      candidates.push({ path, mtime, specificity: cwd.length, direct: true, exact: false });
    } else if (paneDir.startsWith(cwd + "/")) {
      candidates.push({ path, mtime, specificity: cwd.length, direct: false, exact: false });
    }
  }

  if (candidates.length === 0) return null;

  // Exact pane roots and pane-owned git worktrees are both direct session
  // identities; newest activity chooses between them. Generic ancestors keep
  // the old closest-prefix rule, while arbitrary descendants remain rejected.
  candidates.sort((a, b) => {
    if (a.direct !== b.direct) return a.direct ? -1 : 1;
    if (a.direct && b.direct && a.mtime !== b.mtime) return b.mtime - a.mtime;
    if (a.specificity !== b.specificity) return b.specificity - a.specificity;
    return b.mtime - a.mtime;
  });

  return candidates[0].path;
}

const CODEX_PROMPT_CURSOR_KIND = "codex-prompt-events-v1";

function codexPromptEventMatches(event, needle) {
  return event?.type === "event_msg"
    && event.payload?.type === "user_message"
    && event.payload.message === needle;
}

/**
 * Capture the identities of every currently visible occurrence of one exact
 * prompt. A later receipt must contain a NEW event identity, so repeated
 * prompts remain distinguishable without comparing Discord's server clock to
 * the host clock used by Codex JSONL timestamps.
 */
export function captureCodexPromptEchoCursor(paneDir, promptText) {
  const needle = promptText?.trim();
  if (!needle) return null;
  const file = latestSessionFor(paneDir);
  return captureJsonlAppendCursor(CODEX_PROMPT_CURSOR_KIND, file ? [file] : []);
}

/**
 * Check if a given prompt has been written to Codex's rollout jsonl for
 * this pane. Echo confirmation via data, not tmux pane text.
 *
 * @returns boolean (true = prompt found) or null (no session file)
 */
export function isPromptInCodexJsonl(paneDir, promptText, { notBeforeMs = 0, cursor = null } = {}) {
  const needle = promptText?.trim();
  if (!needle) return null;

  const file = latestSessionFor(paneDir);
  if (!file) return null;

  const eventCursor = cursor?.kind === CODEX_PROMPT_CURSOR_KIND;
  const events = eventCursor
    ? jsonlEventsAfterCursor([file], cursor)
    : parseOperationalJsonl(file);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!codexPromptEventMatches(e, needle)) continue;
    if (eventCursor) return true;
    if (notBeforeMs) {
      const eventMs = Date.parse(e.timestamp || "");
      if (!Number.isFinite(eventMs) || eventMs < notBeforeMs) continue;
    }
    return true;
  }
  return false;
}

/**
 * A visible Codex composer can contain text left behind by an older delivery
 * even though that exact user message is already present in the rollout.
 * Prove that relationship from JSONL before clearing a composer while a turn
 * is active.  The minimum overlap keeps short local drafts (for example
 * "ff") out of this automatic recovery path.
 */
export function codexPromptPrefixIdentity(paneDir, composerText, { minOverlap = 48 } = {}) {
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const composer = normalize(composerText);
  if (composer.length < minOverlap) return null;

  const file = latestSessionFor(paneDir);
  if (!file) return null;

  const events = parseOperationalJsonl(file);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "event_msg" || event.payload?.type !== "user_message") continue;
    const submitted = normalize(event.payload.message);
    const overlap = Math.min(composer.length, submitted.length);
    if (overlap >= minOverlap && composer.slice(0, overlap) === submitted.slice(0, overlap)) {
      return event.__hash || null;
    }
  }
  return null;
}

export function isPromptPrefixInCodexJsonl(paneDir, composerText, options = {}) {
  return codexPromptPrefixIdentity(paneDir, composerText, options) !== null;
}

/** Derive live task state from an operational event window. */
export function codexBusyStateFromEvents(events, { truncated = false } = {}) {
  if (!Array.isArray(events) || events.length === 0) return truncated ? true : null;

  let latestStartIdx = -1;
  let latestTurnId = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]?.type === "event_msg" ? events[i].payload : null;
    if (payload?.type === "task_started" && payload.turn_id) {
      latestStartIdx = i;
      latestTurnId = payload.turn_id;
      break;
    }
  }

  if (!latestTurnId) {
    if (!truncated) return false;
    // A terminal event is emitted after all output, so it stays in a bounded
    // tail when the latest turn completed. With no lifecycle event in a
    // truncated growing tail, task_started was pushed out by a still-running
    // long turn: fail busy, never falsely idle.
    const terminal = events.some((event) => {
      const payload = event?.type === "event_msg" ? event.payload : null;
      return payload?.type === "task_complete" || payload?.type === "turn_aborted";
    });
    return !terminal;
  }

  for (let i = latestStartIdx + 1; i < events.length; i++) {
    const payload = events[i]?.type === "event_msg" ? events[i].payload : null;
    if ((payload?.type === "task_complete" || payload?.type === "turn_aborted")
        && payload.turn_id === latestTurnId) return false;
  }
  return true;
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

  const events = parseOperationalJsonl(file);
  if (events.length === 0) return null;
  let truncated = false;
  try { truncated = statSync(file).size > MAX_OPERATIONAL_WINDOW_BYTES; }
  catch { return null; }
  return codexBusyStateFromEvents(events, { truncated });
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
export function latestCodexSessionFor(paneDir, options) {
  return latestSessionFor(paneDir, options);
}

/**
 * Exact pane-owned Codex session identity, or null when this profile has never
 * started in the pane. Ancestor matches are useful for output discovery but
 * are not strong enough for resume ownership, so this requires cwd equality.
 */
export function latestCodexSessionIdentity(paneDir, options) {
  const path = latestSessionFor(paneDir, options);
  if (!path) return null;
  const meta = readSessionMeta(path);
  if (meta?.cwd !== paneDir || !/^[0-9a-f-]{36}$/iu.test(String(meta?.id || ""))) return null;
  return Object.freeze({ sessionId: String(meta.id), cwd: meta.cwd, path });
}

/**
 * Resolve one persisted Codex rollout by its immutable thread id and exact
 * starting cwd. Cutover uses this stricter lookup than latestSessionFor(): an
 * ancestor match is useful for displaying history, but is not proof that a
 * session belongs to the pane being migrated.
 */
export function codexSessionIdentityById(sessionId, paneDir, {
  sessionDirs = codexSessionDirs(),
} = {}) {
  const expectedId = String(sessionId || "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(expectedId)) {
    return null;
  }
  const matches = sessionDirs.flatMap((base) => findJsonlFiles(base, 0, []))
    .map((path) => ({ path, meta: readSessionMeta(path) }))
    .filter(({ meta }) => String(meta?.id || "") === expectedId && meta?.cwd === paneDir);
  if (matches.length !== 1) return null;
  return Object.freeze({ sessionId: expectedId, cwd: paneDir, path: matches[0].path });
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

  // Operational tail readers can begin after the user_message of one very
  // large turn. Automatically reconstruct its visible suffix; requiring each
  // caller to remember `headless` made the watchdog report rows=0 for a live
  // 15MB rollout even though recent assistant events were present.
  let turns = groupCodexIntoTurns(events, { headless: headless || Boolean(tailBytes) });
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
