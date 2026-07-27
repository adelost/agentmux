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

function clipString(value, budget) {
  const source = Buffer.from(value, "utf8");
  if (source.length <= budget) return value;
  const marker = `\n${JSONL_TRIM_MARKER} originalBytes=${source.length}]\n`;
  const markerBytes = Buffer.byteLength(marker);
  if (markerBytes >= budget) return marker;
  const kept = budget - markerBytes;
  const headBudget = Math.ceil(kept * 0.6);
  const tailBudget = kept - headBudget;
  return `${utf8Head(source, headBudget)}${marker}${utf8Tail(source, tailBudget)}`;
}

function clipLargeStrings(value, budget) {
  let count = 0;
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (typeof child === "string" && Buffer.byteLength(child) > budget) {
        node[key] = clipString(child, budget);
        count++;
      } else if (child && typeof child === "object") {
        visit(child);
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

  for (const fieldBudget of FIELD_BUDGETS) {
    const candidate = structuredClone(parsed);
    const trimmedFields = clipLargeStrings(candidate, fieldBudget);
    if (!trimmedFields) continue;
    const text = JSON.stringify(candidate);
    if (Buffer.byteLength(text) <= maxLineBytes) {
      return { text, trimmedFields };
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
