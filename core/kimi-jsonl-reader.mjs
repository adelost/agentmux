// Kimi Code's durable session journal.
//
// Kimi stores one append-only Wire stream per session at:
//   ~/.kimi-code/sessions/<workdir-key>/<session-id>/agents/main/wire.jsonl
// and indexes it in ~/.kimi-code/session_index.jsonl.
//
// The Wire journal is the delivery/source-of-truth boundary. A prompt is
// accepted only after `turn.prompt` or `turn.steer` with the exact text is
// appended; assistant text and tool calls are reconstructed from
// `context.append_loop_event`.

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { captureJsonlAppendCursor, hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { promptRequiresAtomicPaste } from "./prompt-paste.mjs";
import { describeToolCall } from "./tool-display.mjs";

const KIMI_PROMPT_CURSOR_KIND = "kimi-prompt-events-v1";
const DEFAULT_TAIL_BYTES = 8 * 1024 * 1024;
const KIMI_SESSION_ID = /^session_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TERMINAL_FINISH_REASONS = new Set([
  "end_turn",
  "stop",
  "length",
  "max_tokens",
  "content_filter",
  "filtered",
  "completed",
  "truncated",
  "cancelled",
  "error",
]);

function kimiHome({ homeDir = process.env.HOME, env = process.env } = {}) {
  return resolve(env.KIMI_CODE_HOME || join(homeDir || "", ".kimi-code"));
}

function sessionIndexPath(options) {
  return join(kimiHome(options), "session_index.jsonl");
}

function parseJsonLines(text) {
  const rows = [];
  for (const line of String(text || "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      row.__hash = createHash("sha1").update(line).digest("hex").slice(0, 16);
      rows.push(row);
    } catch { /* a partially-written final row is not durable yet */ }
  }
  return rows;
}

function readTail(file, maxBytes = DEFAULT_TAIL_BYTES) {
  let fd;
  try {
    fd = openSync(file, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, Math.max(1, Number(maxBytes) || DEFAULT_TAIL_BYTES));
    const start = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, start);
    let text = buffer.toString("utf8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return parseJsonLines(text);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function readSessionIndex(options) {
  const file = sessionIndexPath(options);
  if (!existsSync(file)) return [];
  try {
    return parseJsonLines(readFileSync(file, "utf8")).filter((row) =>
      KIMI_SESSION_ID.test(String(row?.sessionId || ""))
      && typeof row?.sessionDir === "string"
      && typeof row?.workDir === "string");
  } catch {
    return [];
  }
}

/** WHAT: Resolves one pane's newest Kimi session. WHY: Keeps exact resume separate from cwd-global continuation. */
export function latestKimiSessionIdentity(paneDir, options = {}) {
  const expected = resolve(paneDir);
  const candidates = [];
  for (const row of readSessionIndex(options)) {
    if (resolve(row.workDir) !== expected) continue;
    const wirePath = join(row.sessionDir, "agents", "main", "wire.jsonl");
    if (!existsSync(wirePath)) continue;
    try {
      const stat = statSync(wirePath);
      if (!stat.isFile()) continue;
      candidates.push({
        sessionId: String(row.sessionId),
        cwd: expected,
        path: wirePath,
        sessionDir: row.sessionDir,
        mtimeMs: stat.mtimeMs,
      });
    } catch { /* rotating or incomplete session */ }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (!candidates.length) return null;
  const { mtimeMs: _mtimeMs, ...identity } = candidates[0];
  return Object.freeze(identity);
}

/** WHAT: Resolves one pane's Kimi Wire file. WHY: Keeps callers anchored to pane-owned session identity. */
export function latestKimiSessionFor(paneDir, options = {}) {
  return latestKimiSessionIdentity(paneDir, options)?.path || null;
}

/** WHAT: Reads Kimi Wire file metadata. WHY: Keeps watcher freshness separate from screen rendering. */
export function latestKimiJsonlInfo(paneDir, options = {}) {
  const path = latestKimiSessionFor(paneDir, options);
  if (!path) return null;
  try {
    const stat = statSync(path);
    return { path, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/** WHAT: Reads Kimi Wire modification time. WHY: Keeps activity detection on durable engine state. */
export function latestKimiJsonlMtime(paneDir, options = {}) {
  return latestKimiJsonlInfo(paneDir, options)?.mtimeMs ?? null;
}

/** WHAT: Resolves the active Kimi Wire directory. WHY: Keeps filesystem watches scoped to one pane session. */
export function kimiWatchDir(paneDir, options = {}) {
  const path = latestKimiSessionFor(paneDir, options);
  return path ? dirname(path) : null;
}

function textFromParts(parts) {
  if (!Array.isArray(parts)) return typeof parts === "string" ? parts : "";
  return parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * Kimi's TUI collapses a large/multi-line bracketed paste to an atomic
 * marker (`[paste #1]`, `[paste #1 +24 lines]`, `[paste #2 1234 chars]`) and
 * the Wire journal can then hold only that marker as the prompt text.
 * Mirrors PASTE_MARKER_REGEX in pi-tui's editor.
 */
export const KIMI_PASTE_PLACEHOLDER_RE = /^\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]$/u;

function promptMatches(event, needle, { allowPastePlaceholder = false } = {}) {
  if (event?.type !== "turn.prompt" && event?.type !== "turn.steer") return false;
  const text = textFromParts(event.input).trim();
  if (text === needle) return true;
  // A placeholder event is only accepted as the receipt for a needle that
  // would itself collapse (multi-line/>500 chars). Cursor/FIFO scoping by
  // the caller makes this job's own paste the only one that can land there.
  return allowPastePlaceholder
    && promptRequiresAtomicPaste(needle)
    && KIMI_PASTE_PLACEHOLDER_RE.test(text);
}

/** WHAT: Builds a Kimi prompt cursor. WHY: Keeps identical retries distinct across append boundaries. */
export function captureKimiPromptEchoCursor(paneDir, promptText, options = {}) {
  const needle = promptText?.trim();
  if (!needle) return null;
  const file = latestKimiSessionFor(paneDir, options);
  return captureJsonlAppendCursor(KIMI_PROMPT_CURSOR_KIND, file ? [file] : []);
}

/** WHAT: Checks exact Kimi prompt intake. WHY: Keeps screen echoes from becoming delivery receipts. */
export function isPromptInKimiJsonl(paneDir, promptText, {
  notBeforeMs = 0,
  cursor = null,
  allowPastePlaceholder = false,
  ...options
} = {}) {
  const needle = promptText?.trim();
  if (!needle) return null;
  const file = latestKimiSessionFor(paneDir, options);
  if (!file) return null;
  const matchOpts = { allowPastePlaceholder };
  if (cursor?.kind === KIMI_PROMPT_CURSOR_KIND) {
    return hasJsonlEventAfterCursor([file], cursor, (event) => promptMatches(event, needle, matchOpts));
  }
  const events = readTail(file);
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (!promptMatches(event, needle, matchOpts)) continue;
    if (notBeforeMs && (!Number.isFinite(event.time) || event.time < notBeforeMs)) continue;
    return true;
  }
  return false;
}

function loopEvent(record) {
  return record?.type === "context.append_loop_event" ? record.event : null;
}

/**
 * Kimi turn state from Wire.
 *
 * `turn.prompt` starts a turn and `turn.steer` injects into or starts one.
 * Tool-call step endings remain busy; an end_turn/stop terminal step closes
 * the turn. Fresh sessions with neither input record are idle.
 */
/** WHAT: Reads Kimi turn activity. WHY: Keeps busy state grounded in durable Wire events. */
export function isBusyFromKimiJsonl(paneDir, options = {}) {
  const file = latestKimiSessionFor(paneDir, options);
  if (!file) return null;
  const events = readTail(file);
  if (!events.length) return null;

  let sawPrompt = false;
  let busy = false;
  for (const record of events) {
    if (record?.type === "turn.prompt" || record?.type === "turn.steer") {
      sawPrompt = true;
      busy = true;
      continue;
    }
    if (!sawPrompt) continue;
    const event = loopEvent(record);
    if (event?.type === "step.begin") {
      busy = true;
    } else if (event?.type === "step.end") {
      const reason = String(event.finishReason || "").toLowerCase();
      busy = !TERMINAL_FINISH_REASONS.has(reason);
    } else if (/^turn\\.(?:end|ended|cancel|cancelled|failed)$/u.test(String(record?.type || ""))) {
      busy = false;
    }
  }
  return sawPrompt ? busy : false;
}

function isoTime(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function itemId(record, suffix = 0) {
  return record?.__hash ? `${record.__hash}:${suffix}` : null;
}

function addText(items, text, id) {
  const value = String(text || "").trim();
  if (!value) return;
  const last = items.at(-1);
  if (last?.type === "text") {
    last.content += `\n\n${value}`;
    if (id) last.id = id;
  } else {
    items.push({ type: "text", content: value, id });
  }
}

function markPreviousComplete(turns, current) {
  if (!current) return;
  if (current.items.length > 0) current.isComplete = true;
  turns.push(current);
}

function groupKimiIntoTurns(records, { headless = false } = {}) {
  const turns = [];
  let current = null;

  for (const record of records) {
    if (record?.type === "turn.prompt") {
      markPreviousComplete(turns, current);
      current = {
        timestamp: isoTime(record.time),
        userPrompt: textFromParts(record.input),
        items: [],
        endTimestamp: null,
        isComplete: false,
        turnId: null,
      };
      continue;
    }

    if (!current && headless && record?.type === "context.append_loop_event") {
      current = {
        timestamp: isoTime(record.time),
        userPrompt: "",
        items: [],
        endTimestamp: null,
        isComplete: false,
        turnId: null,
      };
    }
    if (!current) continue;

    if (record?.type === "context.append_message" && record.message?.role === "assistant") {
      addText(current.items, textFromParts(record.message.content), itemId(record));
      current.endTimestamp = isoTime(record.time) || current.endTimestamp;
      continue;
    }

    const event = loopEvent(record);
    if (!event) {
      if (/^turn\\.(?:end|ended|cancel|cancelled|failed)$/u.test(String(record?.type || ""))) {
        current.isComplete = true;
        current.endTimestamp = isoTime(record.time) || current.endTimestamp;
      }
      continue;
    }

    if (event.turnId != null && current.turnId == null) current.turnId = String(event.turnId);
    if (event.type === "content.part") {
      if (event.part?.type === "text") {
        addText(current.items, event.part.text, itemId(record));
        current.endTimestamp = isoTime(record.time) || current.endTimestamp;
      }
    } else if (event.type === "tool.call") {
      const display = describeToolCall(event.name, event.args || {});
      current.items.push({
        type: "tool",
        content: display.content,
        kind: display.kind,
        source: "function",
        id: itemId(record),
      });
      current.endTimestamp = isoTime(record.time) || current.endTimestamp;
    } else if (event.type === "step.end") {
      current.endTimestamp = isoTime(record.time) || current.endTimestamp;
      const reason = String(event.finishReason || "").toLowerCase();
      if (TERMINAL_FINISH_REASONS.has(reason)) current.isComplete = true;
    }
  }
  if (current) turns.push(current);
  return turns;
}

function compactions(records) {
  return records
    .filter((record) => record?.type === "context.apply_compaction")
    .map((record) => ({
      id: record.__hash || isoTime(record.time),
      timestamp: isoTime(record.time),
    }))
    .filter((record) => record.id);
}

/** WHAT: Reads recent Kimi turns. WHY: Keeps CLI history independent from tmux scrollback. */
export function readLastTurnsKimi(paneDir, opts = {}) {
  const {
    limit = 3,
    since = null,
    grep = null,
    tailBytes = null,
    headless = false,
    ...options
  } = opts;
  const file = latestKimiSessionFor(paneDir, options);
  if (!file) return null;
  const records = readTail(file, tailBytes || DEFAULT_TAIL_BYTES);
  let turns = groupKimiIntoTurns(records, { headless: headless || Boolean(tailBytes) });
  if (since) {
    const sinceMs = since instanceof Date ? since.getTime() : new Date(since).getTime();
    turns = turns.filter((turn) => !turn.timestamp || Date.parse(turn.timestamp) >= sinceMs);
  }
  if (grep) {
    turns = turns.filter((turn) =>
      grep.test(turn.userPrompt)
      || turn.items.some((item) => grep.test(item.content)));
  }
  if (turns.length > limit) turns = turns.slice(-limit);
  return { turns, compactions: compactions(records), jsonlFile: file };
}

/** WHAT: Extracts a Kimi response stream. WHY: Keeps delivery replies tied to exact Wire turns. */
export function extractFromKimiJsonl(paneDir, promptText = null, options = {}) {
  const result = readLastTurnsKimi(paneDir, { ...options, limit: Number.MAX_SAFE_INTEGER });
  if (!result) return null;
  const needle = promptText?.trim();
  const turn = needle
    ? [...result.turns].reverse().find((candidate) => candidate.userPrompt.trim() === needle)
    : result.turns.at(-1);
  if (!turn?.items?.length) return null;
  const items = turn.items.map(({ id: _id, ...item }) => item);
  const raw = items.map((item) =>
    item.type === "tool" ? `[tool] ${item.content}` : item.content).join("\n\n");
  return {
    items,
    raw,
    turn: raw,
    source: "kimi-jsonl",
    jsonlFile: result.jsonlFile,
  };
}

function parseConfiguredContextLimit(modelAlias, options = {}) {
  const configPath = join(kimiHome(options), "config.toml");
  let source;
  try { source = readFileSync(configPath, "utf8"); }
  catch { return null; }

  const wanted = String(modelAlias || "").trim();
  let inModel = false;
  let value = null;
  for (const line of source.split("\n")) {
    const section = /^\s*\[([^\]]+)\]\s*(?:#.*)?$/u.exec(line)?.[1];
    if (section) {
      const rawName = section.startsWith("models.") ? section.slice("models.".length) : "";
      const modelName = rawName.replace(/^(["'])(.*)\1$/u, "$2");
      inModel = modelName === wanted;
      continue;
    }
    if (!inModel) continue;
    value = /^\s*max_context_size\s*=\s*([0-9_]+)/iu.exec(line)?.[1] || null;
    if (value) break;
  }
  if (!value) return null;
  const parsed = Number(value.replaceAll("_", ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** WHAT: Reads Kimi context usage. WHY: Keeps status bars grounded in engine-reported token state. */
export function getContextFromKimiJsonl(paneDir, options = {}) {
  const file = latestKimiSessionFor(paneDir, options);
  if (!file) return null;
  const records = readTail(file);
  let model = null;
  let effort = null;
  let tokens = null;

  for (const record of records) {
    if (record?.type === "config.update") {
      if (typeof record.modelAlias === "string") model = record.modelAlias;
      if (typeof record.thinkingEffort === "string") effort = record.thinkingEffort;
    } else if (record?.type === "context.update_token_count" && Number.isFinite(record.tokenCount)) {
      tokens = record.tokenCount;
    } else {
      const event = loopEvent(record);
      if (event?.type === "step.end" && event.usage) {
        const usage = event.usage;
        const fill = Number(usage.inputOther || 0)
          + Number(usage.inputCacheRead || 0)
          + Number(usage.inputCacheCreation || 0)
          + Number(usage.output || 0);
        if (fill > 0) tokens = fill;
      }
    }
  }
  if (!model && tokens == null) return null;
  const max = parseConfiguredContextLimit(model, options);
  const percent = max && tokens != null
    ? Math.max(0, Math.min(100, Math.round((tokens / max) * 100)))
    : null;
  if (percent == null) return null;
  return {
    percent,
    tokens,
    max,
    model,
    effort,
    source: "kimi-jsonl",
    confidence: "exact",
    modelSource: "turn",
  };
}
