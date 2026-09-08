// Cold-path recovery only. Live delivery keeps its existing small tail reader.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { readSearchRecords } from "./search-jsonl.mjs";
import { codexUserPrompt } from "./codex-user-events.mjs";

/** WHAT: Defines the cold history scan ceiling. WHY: Prevents nightly recovery from scanning unbounded journals. */
export const CODEX_DREAM_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_KEPT_BYTES = 8 * 1024 * 1024;

function headerAt(fd, offset) {
  const bytes = Buffer.alloc(512);
  return bytes.toString("utf8", 0, readSync(fd, bytes, 0, bytes.length, offset));
}

function ignorableOversized(header) {
  // Recognize only the writer's top-level prefix, never a quoted type inside
  // user text. An oversized unknown/authored record remains an explicit gap.
  const prefix = /^\{\s*(?:"timestamp"\s*:\s*"[^"\\]*"\s*,\s*)?"type"\s*:\s*"(compacted|response_item)"\s*,\s*/u.exec(header);
  if (!prefix) return false;
  if (prefix[1] === "compacted") return true;
  return /^"payload"\s*:\s*\{\s*"type"\s*:\s*"(?:function_call_output|custom_tool_call_output)"\s*[,}]/u
    .test(header.slice(prefix[0].length));
}

function historyEvent(event) {
  if (codexUserPrompt(event) !== null) return event;
  if (event.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(event.payload?.type)) return event;
  if (event.type === "turn_context") return { ...event, payload: { turn_id: event.payload?.turn_id } };
  if (event.type !== "response_item") return null;
  const payload = event.payload;
  if (payload?.type === "message" && payload.role === "assistant") return event;
  if (["function_call", "custom_tool_call"].includes(payload?.type)) {
    // Preserve the actual tool boundary: merging all commentary into the final
    // answer would make Dream's bounded latest-text selection lose that answer.
    return { ...event, payload: { type: payload.type, name: payload.name, arguments: "", input: "" } };
  }
  return null;
}

/** WHAT: Reads bounded authored history through the existing streaming reader. WHY: Prevents giant compact/tool records from hiding work or entering model context. */
export function readCodexDreamEvents(file, { maxBytes = CODEX_DREAM_SCAN_BYTES, maxKeptBytes = MAX_KEPT_BYTES } = {}) {
  const fd = openSync(file, "r");
  const events = [];
  let keptBytes = 0;
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const previous = Buffer.alloc(1);
    const partial = start > 0 && readSync(fd, previous, 0, 1, start - 1) === 1 && previous[0] !== 10;
    for (const record of readSearchRecords(file, { byteOffset: start, endByteOffset: size })) {
      if (partial && record.byteOffset === start) continue;
      if (record.skippedBytes) {
        if (ignorableOversized(headerAt(fd, record.byteOffset))) continue;
        throw new Error(`dream-history-record-exhausted: oversized unclassified record at byte ${record.byteOffset}`);
      }
      let parsed;
      try { parsed = JSON.parse(record.raw); }
      catch { throw new Error(`dream-history-invalid-record: byte ${record.byteOffset}`); }
      if (!parsed || typeof parsed !== "object") throw new Error("dream-history-invalid-record: not an object");
      const event = historyEvent(parsed);
      if (!event) continue;
      keptBytes += Buffer.byteLength(JSON.stringify(event));
      if (keptBytes > maxKeptBytes) throw new Error("dream-history-content-exhausted: authored history exceeds bounded recovery");
      event.__hash = createHash("sha1").update(record.raw).digest("hex").slice(0, 16);
      events.push(event);
    }
  } finally { closeSync(fd); }
  return events;
}
