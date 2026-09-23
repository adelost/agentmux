// Qwen Code Dual Output is the durable AMUX transport and history boundary.

import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { captureJsonlAppendCursor, hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { describeToolCall } from "./tool-display.mjs";
import { readQwenJournalWindow } from "./qwen-journal-window.mjs";

const QWEN_PROMPT_CURSOR_KIND = "qwen-dual-output-v1";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const GENERATION = /^[A-Za-z0-9._-]{1,160}$/u;

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
const stateBase = (stateRoot) => resolve(stateRoot || join(homedir(), ".agentmux", "qwen-panes"));

function privateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function paneRoot(paneDir, options = {}) {
  return join(stateBase(options.stateRoot), sha256(resolve(paneDir)));
}

function parseLines(file, options = {}) {
  return readQwenJournalWindow(file, options).events;
}

function metadataFor(paneDir, options = {}) {
  const root = paneRoot(paneDir, options);
  try {
    const value = JSON.parse(readFileSync(join(root, "runtime.json"), "utf8"));
    if (value?.version !== 1 || value.paneDir !== resolve(paneDir)
        || !SESSION_ID.test(String(value.sessionId || ""))
        || value.root !== root || !GENERATION.test(String(value.generation || ""))
        || value.eventsPath !== join(root, `events-${value.generation}.jsonl`)
        || value.inputPath !== join(root, `input-${value.generation}.jsonl`)) {
      throw new Error("invalid Qwen runtime binding");
    }
    return value;
  } catch (error) {
    if (options.strict && error.code !== "ENOENT") {
      throw new Error("Qwen continuity blocked: invalid runtime receipt; preserve it for inspection");
    }
    return null;
  }
}

function rootEvent(event, sessionId) {
  return event?.parent_tool_use_id == null
    && (event.session_id ?? event.sessionId) === sessionId;
}

function activeWindow(paneDir, options = {}) {
  const metadata = metadataFor(paneDir, options);
  if (!metadata) return { events: [], truncated: false };
  const window = readQwenJournalWindow(metadata.eventsPath, options);
  return { ...window, events: window.events.filter((event) => rootEvent(event, metadata.sessionId)) };
}

function activeEvents(paneDir, options = {}) {
  return activeWindow(paneDir, options).events;
}

function qwenHome(options = {}) {
  return resolve(options.qwenHome || process.env.QWEN_HOME || join(homedir(), ".qwen"));
}

function contextLimit(model, options = {}) {
  try {
    const settings = JSON.parse(readFileSync(join(qwenHome(options), "settings.json"), "utf8"));
    for (const providers of Object.values(settings.modelProviders || {})) {
      const found = Array.isArray(providers) ? providers.find((entry) => entry?.id === model) : null;
      const value = Number(found?.generationConfig?.contextWindowSize);
      if (Number.isFinite(value) && value > 0) return value;
    }
  } catch { /* unknown remains honest */ }
  return null;
}

function chatPathForSession(sessionId, options = {}) {
  if (!SESSION_ID.test(String(sessionId || ""))) return null;
  const projects = join(qwenHome(options), "projects");
  try {
    for (const entry of readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = join(projects, entry.name, "chats", `${sessionId}.jsonl`);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  } catch { /* no Qwen history yet */ }
  return null;
}

function textParts(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text.trim()).filter(Boolean);
}

function userPromptFromEvent(event) {
  if (event?.type !== "user" || event.message?.role !== "user") return null;
  const parts = event.message?.content;
  if (!Array.isArray(parts) || parts.some((part) => part?.type === "tool_result")) return null;
  return textParts(event.message).join("\n").trim();
}

function groupTurns(events) {
  const turns = [];
  let current = null;
  for (const event of events) {
    const prompt = userPromptFromEvent(event);
    if (prompt != null) {
      if (current) turns.push(current);
      current = {
        userPrompt: prompt,
        sessionId: event.session_id || null,
        model: null,
        items: [],
        usage: null,
        isComplete: false,
      };
      continue;
    }
    if (!current || event?.type !== "assistant" || event.message?.role !== "assistant") continue;
    if (typeof event.model === "string") current.model = event.model;
    if (event.message?.usage && typeof event.message.usage === "object") current.usage = event.message.usage;
    const content = Array.isArray(event.message?.content) ? event.message.content : [];
    let usesTool = false;
    let hasText = false;
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        current.items.push({ type: "text", content: part.text.trim() });
        hasText = true;
      } else if (part?.type === "tool_use" && typeof part.name === "string") {
        const display = describeToolCall(part.name, part.input || {});
        current.items.push({ type: "tool", content: display.content, kind: display.kind, source: "function" });
        usesTool = true;
      }
    }
    if (usesTool) current.isComplete = false;
    else if (hasText) current.isComplete = true;
  }
  if (current) turns.push(current);
  return turns;
}

function chatText(parts, { includeThoughts = false } = {}) {
  if (!Array.isArray(parts)) return [];
  return parts.filter((part) => typeof part?.text === "string" && (includeThoughts || part.thought !== true))
    .map((part) => part.text.trim()).filter(Boolean);
}

function groupChatTurns(records) {
  const turns = [];
  let current = null;
  for (const record of records) {
    if (record?.type === "user" && record.message?.role === "user") {
      if (current) turns.push(current);
      current = {
        timestamp: record.timestamp || null,
        endTimestamp: null,
        userPrompt: chatText(record.message.parts, { includeThoughts: true }).join("\n").trim(),
        sessionId: record.sessionId || null,
        model: null,
        items: [],
        usage: null,
        isComplete: false,
      };
      continue;
    }
    if (!current || record?.type !== "assistant" || record.message?.role !== "model") continue;
    current.model = typeof record.model === "string" ? record.model : current.model;
    current.usage = record.usageMetadata || current.usage;
    current.endTimestamp = record.timestamp || current.endTimestamp;
    let usesTool = false;
    let textIndex = 0;
    for (const [partIndex, part] of (record.message.parts || []).entries()) {
      if (typeof part?.text === "string" && part.thought !== true && part.text.trim()) {
        current.items.push({ type: "text", content: part.text.trim(),
          id: textIndex++ === 0 ? record.__id : `${record.__id}:text:${partIndex}` });
      }
      if (part?.functionCall?.name) {
        const display = describeToolCall(part.functionCall.name, part.functionCall.args || {});
        current.items.push({ type: "tool", content: display.content, kind: display.kind,
          source: "function", id: `${record.__id}:${current.items.length}` });
        usesTool = true;
      }
    }
    current.isComplete = !usesTool && current.items.some((item) => item.type === "text");
  }
  if (current) turns.push(current);
  return turns;
}

function qwenTurns(paneDir, options = {}) {
  const identity = latestQwenSessionIdentity(paneDir, options);
  const chatPath = chatPathForSession(identity?.sessionId, options);
  const windowOptions = { ...options, maxBytes: options.tailBytes };
  if (chatPath) {
    const window = readQwenJournalWindow(chatPath, windowOptions);
    return { turns: groupChatTurns(window.events.filter((event) => rootEvent(event, identity.sessionId))),
      chatPath, truncated: window.truncated };
  }
  const window = activeWindow(paneDir, windowOptions);
  return { turns: groupTurns(window.events), chatPath: identity?.path || null,
    truncated: window.truncated };
}

/** WHAT: Builds private generation files before Qwen starts. WHY: Prevents old commands and events from replaying into a new process. */
export function prepareQwenRuntimeFiles(paneDir, {
  stateRoot = null,
  sessionId,
  model,
  generation = `${Date.now()}-${randomUUID()}`,
} = {}) {
  const resolvedPane = resolve(paneDir);
  if (!SESSION_ID.test(String(sessionId || ""))) throw new Error("invalid Qwen session id");
  if (!GENERATION.test(String(generation || ""))) throw new Error("invalid Qwen process generation");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(String(model || ""))) throw new Error("invalid Qwen model");
  const root = paneRoot(resolvedPane, { stateRoot });
  privateDirectory(stateBase(stateRoot));
  privateDirectory(root);
  const eventsPath = join(root, `events-${generation}.jsonl`);
  const inputPath = join(root, `input-${generation}.jsonl`);
  writeFileSync(eventsPath, "", { mode: 0o600, flag: "wx" });
  writeFileSync(inputPath, "", { mode: 0o600, flag: "wx" });
  return Object.freeze({ root, paneDir: resolvedPane, sessionId, model, generation, eventsPath, inputPath });
}

/** WHAT: Builds a handshake-verified generation receipt. WHY: Prevents delivery from appending to an unobserved Qwen process. */
export function publishQwenRuntime(files) {
  const handshake = parseLines(files.eventsPath, { head: true, maxBytes: 64 * 1024 }).find((event) =>
    event.type === "system" && event.subtype === "session_start");
  if (handshake?.session_id !== files.sessionId
      || resolve(handshake?.data?.cwd || "") !== files.paneDir
      || Number(handshake?.data?.protocol_version || 0) < 2) {
    throw new Error("Qwen Dual Output handshake does not match this pane generation");
  }
  const metadata = {
    version: 1,
    root: files.root,
    paneDir: files.paneDir,
    sessionId: files.sessionId,
    model: files.model,
    generation: files.generation,
    eventsPath: files.eventsPath,
    inputPath: files.inputPath,
    publishedAt: new Date().toISOString(),
  };
  const target = join(files.root, "runtime.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  renameSync(temp, target);
  chmodSync(target, 0o600);
  return metadata;
}

/** WHAT: Resolves the exact pane-owned Qwen session. WHY: Prevents restarts from using cwd-global latest or continue. */
export function latestQwenSessionIdentity(paneDir, options = {}) {
  const metadata = metadataFor(paneDir, options);
  if (!metadata) return null;
  const chatPath = chatPathForSession(metadata.sessionId, options);
  return Object.freeze({
    sessionId: metadata.sessionId,
    cwd: metadata.paneDir,
    model: metadata.model,
    path: chatPath || metadata.eventsPath,
    inputPath: metadata.inputPath,
    generation: metadata.generation,
  });
}

/** WHAT: Builds a Qwen event cursor before one delivery. WHY: Keeps repeated identical prompts distinct without wall-clock guesses. */
export function captureQwenPromptEchoCursor(paneDir, promptText, options = {}) {
  if (!promptText?.trim()) return null;
  const metadata = metadataFor(paneDir, options);
  if (!metadata) return null;
  return { ...captureJsonlAppendCursor(QWEN_PROMPT_CURSOR_KIND, [metadata.eventsPath]),
    sessionId: metadata.sessionId, generation: metadata.generation };
}

/** WHAT: Checks one exact generation's root prompt receipt. WHY: Prevents child or replacement processes from acknowledging another delivery. */
export function isPromptInQwenJsonl(paneDir, promptText, { cursor = null, ...options } = {}) {
  const needle = promptText?.trim();
  if (!needle) return null;
  const metadata = metadataFor(paneDir, options);
  if (!metadata) return false;
  if (cursor?.kind === QWEN_PROMPT_CURSOR_KIND) {
    const bound = SESSION_ID.test(String(cursor.sessionId || ""))
      && GENERATION.test(String(cursor.generation || ""));
    const path = bound ? join(metadata.root, `events-${cursor.generation}.jsonl`) : metadata.eventsPath;
    const sessionId = bound ? cursor.sessionId : metadata.sessionId;
    // Legacy byte cursors remain valid only for files they actually captured.
    if (!Object.hasOwn(cursor.positions || {}, path)) return false;
    const handshake = parseLines(path, { head: true, maxBytes: 64 * 1024 }).find((event) =>
      event.type === "system" && event.subtype === "session_start");
    if (handshake?.session_id !== sessionId || handshake.data?.cwd !== resolve(paneDir)) return false;
    return hasJsonlEventAfterCursor([path], cursor, (event) =>
      rootEvent(event, sessionId) && userPromptFromEvent(event) === needle);
  }
  return activeEvents(paneDir, options).some((event) => userPromptFromEvent(event) === needle);
}

/** WHAT: Reads Qwen turn activity. WHY: Keeps busy state grounded in structured engine events. */
export function isBusyFromQwenJsonl(paneDir, options = {}) {
  const turns = groupTurns(activeEvents(paneDir, options));
  return turns.length ? !turns.at(-1).isComplete : null;
}

/** WHAT: Extracts one Qwen response stream. WHY: Keeps Discord replies separate from terminal chrome and private reasoning. */
export function extractFromQwenJsonl(paneDir, prompt = null, options = {}) {
  const { turns, chatPath } = qwenTurns(paneDir, options);
  const needle = prompt?.trim();
  const turn = needle
    ? [...turns].reverse().find((candidate) => candidate.userPrompt.trim() === needle)
    : turns.at(-1);
  if (!turn?.items?.length) return null;
  const items = turn.items.map((item) => ({ ...item }));
  const raw = items.map((item) => item.type === "tool" ? `[tool] ${item.content}` : item.content).join("\n\n");
  return {
    items,
    raw,
    turn: raw,
    source: "qwen-dual-output",
    model: turn.model,
    sessionId: turn.sessionId,
    usage: turn.usage,
    jsonlFile: chatPath,
  };
}

/** WHAT: Reads Qwen model and token usage. WHY: Keeps status evidence separate from configured model labels. */
export function getContextFromQwenJsonl(paneDir, options = {}) {
  const identity = latestQwenSessionIdentity(paneDir, options);
  const chatPath = chatPathForSession(identity?.sessionId, options);
  const records = chatPath ? parseLines(chatPath).filter((event) => rootEvent(event, identity.sessionId))
    : activeEvents(paneDir, options);
  let model = null;
  let sessionId = identity?.sessionId || null;
  let usage = null;
  for (const event of records) {
    if (event?.type === "system" && event.subtype === "session_start") sessionId = event.session_id || sessionId;
    if (event?.type === "assistant") {
      if (typeof event.model === "string") model = event.model;
      if (event.message?.usage && typeof event.message.usage === "object") usage = event.message.usage;
      if (event.usageMetadata && typeof event.usageMetadata === "object") usage = event.usageMetadata;
    }
  }
  const tokens = Number.isFinite(usage?.total_tokens) ? usage.total_tokens
    : Number.isFinite(usage?.totalTokenCount) ? usage.totalTokenCount
      : Number(usage?.input_tokens || 0) + Number(usage?.output_tokens || 0) || null;
  if (!model && tokens == null) return null;
  const info = latestQwenJsonlInfo(paneDir, options);
  const max = contextLimit(model, options);
  return {
    percent: max && tokens != null ? Math.max(0, Math.min(100, Math.round((tokens / max) * 100))) : null,
    tokens,
    max,
    model,
    effort: null,
    sessionId,
    observedAt: info ? new Date(info.mtimeMs).toISOString() : null,
    source: "qwen-dual-output",
    confidence: "reported",
    modelSource: "turn",
  };
}

/** WHAT: Reads Qwen journal metadata. WHY: Keeps watcher freshness separate from terminal rendering. */
export function latestQwenJsonlInfo(paneDir, options = {}) {
  const identity = latestQwenSessionIdentity(paneDir, options);
  const file = chatPathForSession(identity?.sessionId, options) || identity?.path;
  if (!file) return null;
  try {
    const stat = statSync(file);
    return { path: file, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch { return null; }
}

/** WHAT: Reads Qwen journal modification time. WHY: Keeps activity overlays separate from TUI animation. */
export const latestQwenJsonlMtime = (paneDir, options = {}) =>
  latestQwenJsonlInfo(paneDir, options)?.mtimeMs ?? null;

/** WHAT: Resolves Qwen's AMUX event directory. WHY: Keeps filesystem watches scoped to one pane. */
export const qwenWatchDir = (paneDir, options = {}) => paneRoot(paneDir, options);

/** WHAT: Builds one broker-owned Qwen input record and fsyncs it. WHY: Keeps exact UTF-8 intake separate from terminal typing. */
export async function submitQwenPrompt(paneDir, text, options = {}) {
  const value = String(text || "");
  if (!value.trim()) throw new Error("Qwen prompt is empty");
  const metadata = metadataFor(paneDir, options);
  if (!metadata || !existsSync(metadata.inputPath)) throw new Error("Qwen pane runtime is not published");
  const line = `${JSON.stringify({ type: "submit", text: value })}\n`;
  const fd = openSync(metadata.inputPath, "a", 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return { sessionId: metadata.sessionId, generation: metadata.generation, bytes: Buffer.byteLength(line) };
}

/** WHAT: Reads recent timestamped Qwen turns. WHY: Keeps logs and Dream input separate from Dual Output transport records. */
export function readLastTurnsQwen(paneDir, opts = {}) {
  const { limit = 3, grep = null, since = null, ...options } = opts;
  const result = qwenTurns(paneDir, options);
  let turns = result.turns;
  if (since) {
    const sinceMs = since instanceof Date ? since.getTime() : Date.parse(since);
    turns = turns.filter((turn) => !turn.timestamp || Date.parse(turn.timestamp) >= sinceMs);
  }
  if (grep) turns = turns.filter((turn) => grep.test(turn.userPrompt)
    || turn.items.some((item) => grep.test(item.content)));
  if (turns.length > limit) turns = turns.slice(-limit);
  return turns.length ? { turns, compactions: [], jsonlFile: result.chatPath, truncated: result.truncated } : null;
}
