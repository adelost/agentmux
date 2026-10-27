// Native root history supplies public output. Generation-scoped hooks supply intake/completion receipts.
import { statSync } from "node:fs";
import { join } from "node:path";
import { captureJsonlAppendCursor, hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { readQwenJournalWindow as readJournalWindow } from "./qwen-journal-window.mjs";
import { latestGeminiSessionIdentity, geminiWatchDir } from "./gemini-pane-files.mjs";
import { describeToolCall } from "./tool-display.mjs";

export { latestGeminiSessionIdentity, geminiWatchDir } from "./gemini-pane-files.mjs";
/** WHAT: Defines Gemini's generation-bound receipt protocol. WHY: Keeps its append cursors separate from other engines' journals. */
export const GEMINI_PROMPT_CURSOR_KIND = "gemini-hooks-v1";

function rootHook(event, identity) {
  return event.session_id === identity.sessionId && event.generation === identity.generation
    && event.parent_tool_use_id == null && event.parent_session_id == null;
}

function activeHooks(identity, options = {}) {
  if (!identity) return [];
  return readJournalWindow(identity.eventsPath, { maxBytes: options.tailBytes }).events
    .filter(event => rootHook(event, identity));
}

function textParts(content) {
  if (typeof content === "string") return content.trim() ? [content.trim()] : [];
  if (!Array.isArray(content)) return [];
  return content.filter(part => typeof part?.text === "string" && part.thought !== true)
    .map(part => part.text.trim()).filter(Boolean);
}

function userPrompt(record) {
  if (record.type !== "user") return null;
  const prompt = textParts(record.content).join("\n");
  if (!prompt || /^\s*<(?:session_context|hook_context)>/u.test(prompt)) return null;
  return prompt;
}

function nativeWindow(identity, options) {
  if (!identity?.path) return null;
  const header = readJournalWindow(identity.path, { head: true, maxBytes: 64 * 1024 }).events[0];
  if (header?.sessionId !== identity.sessionId || header.kind !== "main") return null;
  return readJournalWindow(identity.path, { maxBytes: options.tailBytes });
}

function publicItems(record) {
  const items = textParts(record.content).map((content, index) => ({
    type: "text", content, id: `${record.id}:text:${index}`,
  }));
  for (const tool of record.toolCalls || []) {
    if (!tool?.name) continue;
    const name = tool.name === "run_shell_command" ? "exec_command" : tool.name;
    const display = describeToolCall(name, tool.args || {});
    items.push({ type: "tool", ...display, source: "function", id: `${record.id}:tool:${tool.id}` });
  }
  return items;
}

function groupTurns(records, identity, hooks) {
  // The native journal appends replacements with the same id (tokens/tool status).
  // Keeping insertion order but the latest value prevents mirrored duplicate text.
  const messages = new Map();
  for (const record of records) {
    if (!record.id || record.parent_tool_use_id != null || record.parentSessionId != null
        || (record.sessionId && record.sessionId !== identity.sessionId)) continue;
    messages.set(record.id, record);
  }
  const turns = [];
  let current = null;
  for (const record of messages.values()) {
    const prompt = userPrompt(record);
    if (prompt != null) {
      if (current) turns.push(current);
      current = { userPrompt: prompt, sessionId: identity.sessionId, timestamp: record.timestamp || null,
        endTimestamp: null, model: null, usage: null, items: [], isComplete: false };
    } else if (current && record.type === "gemini") {
      current.model = record.model || current.model;
      current.usage = record.tokens || current.usage;
      current.endTimestamp = record.timestamp || current.endTimestamp;
      current.items.push(...publicItems(record));
      current.isComplete = current.items.some(item => item.type === "text")
        && !(record.toolCalls || []).some(tool => ["pending", "executing", "validating", "awaiting_approval"].includes(tool.status));
    }
  }
  if (current) {
    const last = hooks.filter(hook => ["BeforeAgent", "AfterAgent"].includes(hook.hook_event_name)).at(-1);
    current.isComplete = Boolean(last?.hook_event_name === "AfterAgent" && last.prompt === current.userPrompt);
    turns.push(current);
  }
  return turns;
}

/** WHAT: Reads bounded exact-root Gemini history. WHY: Prevents setup prompts, private thoughts and subagents from becoming mirrored replies. */
export function readLastTurnsGemini(paneDir, { limit = 3, grep = null, since = null, ...options } = {}) {
  const identity = latestGeminiSessionIdentity(paneDir, options);
  const window = nativeWindow(identity, options);
  if (!window) return null;
  let turns = groupTurns(window.events, identity, activeHooks(identity, options));
  if (since) {
    const boundary = since instanceof Date ? since.getTime() : Date.parse(since);
    turns = turns.filter(turn => !turn.timestamp || Date.parse(turn.timestamp) >= boundary);
  }
  if (grep) turns = turns.filter(turn => {
    grep.lastIndex = 0;
    return grep.test([turn.userPrompt, ...turn.items.map(item => item.content)].join("\n"));
  });
  if (turns.length > limit) turns = turns.slice(-limit);
  return turns.length ? { turns, compactions: [], jsonlFile: identity.path, truncated: window.truncated } : null;
}

/** WHAT: Builds an exact session/generation cursor before submit. WHY: Keeps identical prompts and later replacement processes from sharing a receipt. */
export function captureGeminiPromptEchoCursor(paneDir, prompt, options = {}) {
  if (!prompt?.trim()) return null;
  const identity = latestGeminiSessionIdentity(paneDir, options);
  if (!identity) return null;
  return { ...captureJsonlAppendCursor(GEMINI_PROMPT_CURSOR_KIND, [identity.eventsPath]),
    sessionId: identity.sessionId, generation: identity.generation };
}

/** WHAT: Checks one append-only BeforeAgent receipt. WHY: Prevents another session, generation or child from acknowledging the root delivery. */
export function isPromptInGeminiJsonl(paneDir, prompt, { cursor = null, ...options } = {}) {
  const needle = prompt?.trim();
  if (!needle) return null;
  if (!cursor) {
    const identity = latestGeminiSessionIdentity(paneDir, options);
    return activeHooks(identity, options).some(event => event.hook_event_name === "BeforeAgent" && event.prompt?.trim() === needle);
  }
  if (cursor.kind !== GEMINI_PROMPT_CURSOR_KIND || !/^[0-9a-f-]{36}$/iu.test(cursor.sessionId || "")
      || !/^[a-z0-9._-]{1,160}$/iu.test(cursor.generation || "")) return false;
  const path = join(geminiWatchDir(paneDir, options), `events-${cursor.generation}.jsonl`);
  if (!Object.hasOwn(cursor.positions || {}, path)) return false;
  return hasJsonlEventAfterCursor([path], cursor, event => rootHook(event, cursor)
    && event.hook_event_name === "BeforeAgent" && event.prompt?.trim() === needle);
}

/** WHAT: Reads authoritative completion or returns unknown. WHY: Keeps a missing AfterAgent from trapping an interrupted idle pane as busy. */
export function isBusyFromGeminiJsonl(paneDir, options = {}) {
  const identity = latestGeminiSessionIdentity(paneDir, options);
  const last = activeHooks(identity, options).filter(event => ["BeforeAgent", "AfterAgent", "SessionEnd"].includes(event.hook_event_name)).at(-1);
  return last?.hook_event_name === "AfterAgent" ? false : null;
}

/** WHAT: Extracts public Gemini turn items. WHY: Keeps Discord mirroring on native journal identity rather than terminal paint. */
export function extractFromGeminiJsonl(paneDir, prompt = null, options = {}) {
  const history = readLastTurnsGemini(paneDir, { limit: 100, ...options });
  const needle = prompt?.trim();
  const turn = needle ? history?.turns.findLast(candidate => candidate.userPrompt.trim() === needle) : history?.turns.at(-1);
  if (!turn?.items.length) return null;
  const raw = turn.items.map(item => item.type === "tool" ? `[tool] ${item.content}` : item.content).join("\n\n");
  return { items: turn.items, raw, turn: raw, source: "gemini-jsonl", model: turn.model,
    sessionId: turn.sessionId, usage: turn.usage, jsonlFile: history.jsonlFile };
}

/** WHAT: Reads the freshest Gemini journal or hook timestamp. WHY: Keeps watcher activity visible before and after native transcript creation. */
export function latestGeminiJsonlInfo(paneDir, options = {}) {
  const identity = latestGeminiSessionIdentity(paneDir, options);
  if (!identity) return null;
  const readings = [identity.path, identity.eventsPath].filter(Boolean).flatMap(path => {
    try { const stat = statSync(path); return [{ path, mtimeMs: stat.mtimeMs, size: stat.size }]; } catch { return []; }
  });
  return readings.sort((a, b) => b.mtimeMs - a.mtimeMs)[0] || null;
}

/** WHAT: Reads one Gemini journal modification time. WHY: Keeps generic activity consumers off provider-specific paths. */
export const latestGeminiJsonlMtime = (paneDir, options = {}) => latestGeminiJsonlInfo(paneDir, options)?.mtimeMs ?? null;

/** WHAT: Reads observed Gemini model and token usage. WHY: Keeps unknown context limits separate from configured Auto or guessed percentages. */
export function getContextFromGeminiJsonl(paneDir, options = {}) {
  const last = readLastTurnsGemini(paneDir, { limit: 1, ...options })?.turns.at(-1);
  if (!last?.model && !last?.usage) return null;
  const info = latestGeminiJsonlInfo(paneDir, options);
  return { percent: null, tokens: Number.isFinite(last.usage?.total) ? last.usage.total : null, max: null,
    model: last.model, effort: null, sessionId: last.sessionId, observedAt: info ? new Date(info.mtimeMs).toISOString() : null,
    source: "gemini-jsonl", confidence: "reported", modelSource: "turn" };
}
