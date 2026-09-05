// Journal retrieval is event-scoped. Files are storage, not timestamps or authority.
import fs from "node:fs";
import { createHash } from "node:crypto";
import { codexUserPrompt, iterateCodexUserEvents } from "./codex-user-events.mjs";

const CHUNK_BYTES = 64 * 1024;
const MAX_EVENT_BYTES = 4 * 1024 * 1024;
const MAX_CONTEXT = 20;
const MAX_TEXT = 16_000;
const MAX_OUTPUT = 32_000;

/** WHAT: Streams numbered JSONL records from a byte position. WHY: Bounds memory and makes expansion independent of the journal's total size. */
export function* readSearchRecords(path, { byteOffset = 0, line = 1, endLine = Infinity } = {}) {
  const fd = fs.openSync(path, "r");
  const buffer = Buffer.alloc(CHUNK_BYTES);
  let position = byteOffset;
  let start = byteOffset;
  let parts = [];
  let length = 0;
  try {
    const endOffset = fs.fstatSync(fd).size;
    while (line <= endLine) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, Math.max(0, endOffset - position)), position);
      if (!count) {
        if (length) yield record();
        break;
      }
      let from = 0;
      while (from < count && line <= endLine) {
        const newline = buffer.indexOf(10, from);
        const to = newline < 0 || newline >= count ? count : newline;
        length += to - from;
        if (length > MAX_EVENT_BYTES) parts = [];
        else parts.push(Buffer.from(buffer.subarray(from, to)));
        if (to === count) break;
        yield record();
        line++;
        parts = [];
        length = 0;
        start = position + to + 1;
        from = to + 1;
      }
      position += count;
    }
  } finally { fs.closeSync(fd); }

  function record() {
    return { raw: length > MAX_EVENT_BYTES ? null : Buffer.concat(parts, length).toString("utf8"),
      skippedBytes: length > MAX_EVENT_BYTES ? length : 0, line, byteOffset: start };
  }
}

function parseRecord(raw) {
  try {
    const event = JSON.parse(raw);
    return event && typeof event === "object" && !Array.isArray(event) ? event : null;
  } catch { return null; }
}

function eventDate(event) {
  const timestamp = event.timestamp ?? event.ts;
  const ms = typeof timestamp === "string" || typeof timestamp === "number" ? new Date(timestamp).getTime() : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function textBlocks(content, types) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((block) => types.includes(block?.type))
    .map((block) => block.text || "").join("\n") : "";
}

/** WHAT: Returns labelled decoded event text. WHY: Separates authored input from quoted setup, tool output and search ranking. */
export function describeSearchEvent(event) {
  const date = eventDate(event);
  const authored = codexUserPrompt(event);
  if (authored !== null) return { date, role: "USER", text: authored };
  const payload = event.payload;
  if (event.type === "response_item") {
    if (payload?.type === "message") return { date,
      role: payload.role === "assistant" ? "ASSI" : "CONTEXT",
      text: textBlocks(payload.content, ["input_text", "output_text", "text"]) };
    if (["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(payload?.type)) {
      const text = payload.output ?? payload.arguments ?? payload.input;
      return { date, role: "TOOL", text: typeof text === "string" ? text : "" };
    }
  }
  if (event.message?.role) {
    const role = event.message.role;
    return { date, role: role === "user" ? "USER" : role === "assistant" ? "ASSI" : "CONTEXT",
      text: textBlocks(event.message.content, ["text"]) };
  }
  if (event.event) return { date, role: "EVENT",
    text: `${event.event} ${event.session ?? ""}:${event.pane ?? ""} ${event.detail || ""}`.trim() };
  // Untyped legacy text is searchable, but is not evidence of authored input.
  const text = event.text ?? event.content ?? payload?.text;
  return { date, role: event.type === "event_msg" && payload?.type === "agent_message" ? "ASSI" : "EVENT",
    text: typeof text === "string" ? text : "" };
}

function digest(raw) { return createHash("sha256").update(raw).digest("hex"); }

function* locatedEvents(path, skipped) {
  const before = [];
  for (const record of readSearchRecords(path)) {
    const event = parseRecord(record.raw);
    if (record.skippedBytes) {
      skipped.count++;
      skipped.firstLine ??= record.line;
    }
    // Invalid records are barriers too: do not infer mirror equivalence across corruption.
    yield { ...(event || { type: "event_msg", payload: { type: "task_complete" } }),
      searchLocation: { ...record, before: [...before] } };
    before.push({ line: record.line, byteOffset: record.byteOffset });
    if (before.length > MAX_CONTEXT) before.shift();
  }
}

function boundedPattern(query) {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "iu");
}

function newest(a, b) {
  return (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.line - a.line;
}

/** WHAT: Returns the newest bounded distinct journal matches. WHY: Prevents early-file matches and mirror encodings from hiding later decisions or repeated real inputs. */
export function searchJsonlFiles(query, files, { max = 12, includeFileAnd = true, onWarning = console.warn } = {}) {
  const phrase = boundedPattern(query);
  const words = query.split(/\s+/).filter(Boolean).map(boundedPattern);
  const hits = [];
  for (const path of files) {
    const skipped = { count: 0, firstLine: null };
    for (const event of iterateCodexUserEvents(locatedEvents(path, skipped))) {
      const { date, role, text } = describeSearchEvent(event);
      if (!text) continue;
      const exact = phrase.exec(text);
      if (!exact && !(includeFileAnd && words.length > 1 && words.every((word) => word.test(text)))) continue;
      const { raw, ...location } = event.searchLocation;
      const start = Math.max(0, (exact?.index ?? 0) - 60);
      hits.push({ path, ...location, date, role, recordHash: digest(raw),
        layer: exact ? "L1" : "L2", dedupeKey: `${path}#${location.byteOffset}`,
        snippet: `${role}: ${text.slice(start, start + 300).replace(/\s+/g, " ")}` });
      hits.sort(newest);
      if (hits.length > max) hits.pop();
    }
    if (skipped.count) onWarning(`Search incomplete: ${skipped.count} event(s) over ${MAX_EVENT_BYTES} bytes omitted in ${path}; first at ${path}:${skipped.firstLine}. Later events were still searched.`);
  }
  return hits;
}

function limited(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated after ${max} characters]`;
}

/** WHAT: Formats decoded evidence with a visible output bound. WHY: Keeps exact multiline quotes separate from raw metadata and unlimited tool output. */
export function renderJsonlLine(raw) {
  const event = parseRecord(raw);
  if (!event) return null;
  const { date, role, text } = describeSearchEvent(event);
  return text ? `${date || "unknown time"} ${role}: ${limited(text, MAX_TEXT)}` : null;
}

/** WHAT: Expands local physical neighbors at a saved search position. WHY: Prevents a small quote from allocating a whole journal or silently showing a rewritten source. */
export function expandJsonlHit(hit, { context = 10 } = {}) {
  const requested = Math.max(0, Number(context) || 0);
  const count = Math.min(MAX_CONTEXT, requested);
  const firstLine = Math.max(1, hit.line - count);
  const checkpoint = count === 0 && Number.isInteger(hit.byteOffset)
    ? { line: hit.line, byteOffset: hit.byteOffset }
    : hit.before?.find((entry) => entry.line === firstLine);
  const options = { ...(checkpoint || {}), endLine: hit.line + count };
  const rendered = [];
  let matched = false;
  for (const record of readSearchRecords(hit.path, options)) {
    if (record.line < firstLine) continue;
    if (record.line === hit.line) {
      matched = true;
      if (hit.recordHash && (record.raw === null || digest(record.raw) !== hit.recordHash)) return "Source changed since search; run the query again.";
    }
    const text = record.skippedBytes ? `[event omitted: ${record.skippedBytes} bytes exceeds the ${MAX_EVENT_BYTES}-byte limit]`
      : renderJsonlLine(record.raw) || "[event has no supported text]";
    rendered.push({ selected: record.line === hit.line, line: record.line, text });
  }
  if (!matched) return "Source no longer contains the matched line; run the query again.";
  // Reserve the matched quote first; noisy preceding neighbors cannot consume it.
  const selectedLength = rendered.find((record) => record.selected).text.length;
  const neighborBudget = Math.floor((MAX_OUTPUT - selectedLength - 3000) / Math.max(1, rendered.length - 1));
  const lines = rendered.map((record) => `${record.selected ? "▶" : " "} ${record.line} ${
    record.selected ? record.text : limited(record.text, neighborBudget)}`);
  if (requested > MAX_CONTEXT) lines.push(`[context limited to ${MAX_CONTEXT} neighboring records per side]`);
  return lines.join("\n");
}
