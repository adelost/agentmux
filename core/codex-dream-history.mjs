// Cold-path recovery only. Live delivery keeps its existing small tail reader.
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { createHash } from "node:crypto";
import { readSearchRecords } from "./search-jsonl.mjs";
import { codexUserPrompt } from "./codex-user-events.mjs";
import { readCodexRecordPrefix } from "./codex-record-prefix.mjs";
import { needsCodexDreamOrigin, readCodexDreamOrigin, codexDreamOriginEvents } from "./codex-dream-origin.mjs";

/** WHAT: Defines the initial cold history window. WHY: Keeps retained output bounded while origin recovery can seek older input. */
export const CODEX_DREAM_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_KEPT_BYTES = 8 * 1024 * 1024;

const LIFECYCLE_TYPES = new Set(["task_started", "task_complete", "turn_aborted"]);
const TOOL_CALL_TYPES = new Set(["function_call", "custom_tool_call"]);

function needsHistoryRecord({ type, payloadType }) {
  // user_message and response_item/message are codexUserPrompt's two inputs.
  // The remaining types are exactly historyEvent's lifecycle/tool boundaries.
  return type === "turn_context"
    || (type === "event_msg" && (payloadType === "user_message" || LIFECYCLE_TYPES.has(payloadType)))
    || (type === "response_item" && (payloadType === "message" || TOOL_CALL_TYPES.has(payloadType)));
}

function historyEvent(event) {
  if (codexUserPrompt(event) !== null) return event;
  if (event.type === "event_msg" && LIFECYCLE_TYPES.has(event.payload?.type)) return event;
  if (event.type === "turn_context") return { ...event, payload: { turn_id: event.payload?.turn_id } };
  if (event.type !== "response_item") return null;
  const payload = event.payload;
  if (payload?.type === "message" && payload.role === "assistant") return event;
  if (TOOL_CALL_TYPES.has(payload?.type)) {
    // Preserve the actual tool boundary: merging all commentary into the final
    // answer would make Dream's bounded latest-text selection lose that answer.
    return { ...event, payload: { type: payload.type, name: payload.name, arguments: "", input: "" } };
  }
  return null;
}

/** WHAT: Reads bounded authored history through the existing streaming reader. WHY: Prevents giant compact/tool records from hiding work or entering model context. */
export function readCodexDreamEvents(file, { maxBytes = CODEX_DREAM_SCAN_BYTES, maxKeptBytes = MAX_KEPT_BYTES,
  endByteOffset = Infinity } = {}) {
  const fd = openSync(file, "r");
  const events = [];
  let keptBytes = 0;
  try {
    const size = Math.min(fstatSync(fd).size, endByteOffset);
    const start = Math.max(0, size - maxBytes);
    const previous = Buffer.alloc(1);
    const partial = start > 0 && readSync(fd, previous, 0, 1, start - 1) === 1 && previous[0] !== 10;
    let firstBoundary = null;
    for (const record of readSearchRecords(file, { byteOffset: start, endByteOffset: size })) {
      if (partial && record.byteOffset === start) continue;
      firstBoundary ??= record.byteOffset;
      if (record.skippedBytes) {
        const prefix = readCodexRecordPrefix(fd, record.byteOffset);
        if (prefix && !needsHistoryRecord(prefix)) continue;
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
    if (firstBoundary > 0 && needsCodexDreamOrigin(events)) {
      const origin = codexDreamOriginEvents(readCodexDreamOrigin(file, firstBoundary, fd), events);
      if (keptBytes + Buffer.byteLength(JSON.stringify(origin)) > maxKeptBytes) {
        throw new Error("dream-history-content-exhausted: origin exceeds bounded recovery");
      }
      events.unshift(...origin);
    }
  } finally { closeSync(fd); }
  return events;
}
