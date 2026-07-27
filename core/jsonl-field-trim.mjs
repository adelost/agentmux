const DEFAULT_MAX_LINE_BYTES = 100 * 1024;
const FIELD_BUDGETS = Object.freeze([
  64 * 1024,
  48 * 1024,
  32 * 1024,
  24 * 1024,
  16 * 1024,
  12 * 1024,
  8 * 1024,
  4 * 1024,
  2 * 1024,
  1024,
  512,
]);
const TRIM_ORDER = Object.freeze(["tool", "other", "conversation"]);
const TOOL_TYPES = new Set([
  "custom_tool_call", "custom_tool_call_output", "function_call", "function_call_output",
  "image", "input_audio", "input_image", "mcp_tool_call", "tool_result", "tool_use",
]);
const CONVERSATION_TYPES = new Set(["input_text", "message", "output_text", "text"]);
const TOOL_FIELD_KEYS = new Set(["arguments", "command", "input", "output", "result"]);

/** WHAT: Defines the aged-field trim marker. WHY: Keeps lossy text from resembling a complete provider record. */
export const JSONL_TRIM_MARKER = "[AMUX_TRIMMED";

function utf8Head(buffer, budget) {
  if (budget >= buffer.length) return buffer.toString("utf8");
  let end = Math.max(0, budget);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

function utf8Tail(buffer, budget) {
  if (budget >= buffer.length) return buffer.toString("utf8");
  let start = Math.max(0, buffer.length - budget);
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  return buffer.subarray(start).toString("utf8");
}

function clipString(value, budget, kind) {
  const source = Buffer.from(value, "utf8");
  if (source.length <= budget) return value;
  const marker = `\n${JSONL_TRIM_MARKER} kind=${kind} originalBytes=${source.length}]\n`;
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= budget) return marker;
  const kept = budget - markerBytes;
  const headBudget = Math.ceil(kept * 0.6);
  const tailBudget = kept - headBudget;
  return `${utf8Head(source, headBudget)}${marker}${utf8Tail(source, tailBudget)}`;
}

function nodeKind(node, inherited) {
  const type = typeof node?.type === "string" ? node.type : null;
  if (type && TOOL_TYPES.has(type)) return "tool";
  if (type && CONVERSATION_TYPES.has(type)) return "conversation";
  if (typeof node?.role === "string"
    && ["assistant", "system", "user"].includes(node.role)) return "conversation";
  return inherited;
}

function clipLargeStrings(value, budgets) {
  let count = 0;
  const visit = (node, inheritedKind = "other") => {
    if (!node || typeof node !== "object") return;
    const kind = nodeKind(node, inheritedKind);
    for (const key of Object.keys(node)) {
      const child = node[key];
      const childKind = TOOL_FIELD_KEYS.has(key) ? "tool" : kind;
      const budget = budgets[childKind];
      if (typeof child === "string" && Number.isFinite(budget)
        && Buffer.byteLength(child) > budget) {
        node[key] = clipString(child, budget, childKind);
        count++;
      } else if (child && typeof child === "object") {
        visit(child, childKind);
      }
    }
  };
  visit(value);
  return count;
}

function trimObjectLine(line, maxLineBytes) {
  let parsed;
  try { parsed = JSON.parse(line); }
  catch (error) { throw new Error(`invalid-jsonl-line:${error.message}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("jsonl-line-is-not-object");
  }

  const budgets = { tool: Infinity, other: Infinity, conversation: Infinity };
  for (const kind of TRIM_ORDER) {
    for (const fieldBudget of FIELD_BUDGETS) {
      budgets[kind] = fieldBudget;
      const candidate = structuredClone(parsed);
      const trimmedFields = clipLargeStrings(candidate, budgets);
      if (!trimmedFields) continue;
      const text = JSON.stringify(candidate);
      if (Buffer.byteLength(text) <= maxLineBytes) {
        return { text, trimmedFields };
      }
    }
  }
  throw new Error(`jsonl-line-cannot-fit-${maxLineBytes}-bytes`);
}

/**
 * WHAT: Maps oversized string fields to bounded marked text.
 * WHY: Keeps storage reclaim from deleting searchable provider records.
 */
export function trimJsonlBuffer(source, {
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
} = {}) {
  const beforeBytes = source.length;
  const hadFinalNewline = beforeBytes > 0 && source[beforeBytes - 1] === 0x0a;
  const lines = source.toString("utf8").split("\n");
  const recordCount = hadFinalNewline ? lines.length - 1 : lines.length;
  let trimmedLines = 0;
  let trimmedFields = 0;

  for (let index = 0; index < recordCount; index++) {
    const raw = lines[index].endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
    if (!raw) throw new Error(`invalid-jsonl-empty-line:${index + 1}`);
    if (Buffer.byteLength(raw) <= maxLineBytes) continue;
    let result;
    try { result = trimObjectLine(raw, maxLineBytes); }
    catch (error) { throw new Error(`line-${index + 1}:${error.message}`); }
    lines[index] = result.text;
    trimmedLines++;
    trimmedFields += result.trimmedFields;
  }

  if (!trimmedLines) {
    return {
      buffer: source,
      beforeBytes,
      afterBytes: beforeBytes,
      reclaimedBytes: 0,
      records: recordCount,
      trimmedLines: 0,
      trimmedFields: 0,
    };
  }

  const buffer = Buffer.from(lines.join("\n"), "utf8");
  if (buffer.length >= beforeBytes) throw new Error("jsonl-trim-did-not-reclaim");
  return {
    buffer,
    beforeBytes,
    afterBytes: buffer.length,
    reclaimedBytes: beforeBytes - buffer.length,
    records: recordCount,
    trimmedLines,
    trimmedFields,
  };
}
