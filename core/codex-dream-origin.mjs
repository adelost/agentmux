import { createHash } from "node:crypto";
import { readSearchRecords } from "./search-jsonl.mjs";
import { classifyCodexRecordPrefix, readCodexRecordPrefix } from "./codex-record-prefix.mjs";
import { codexUserPrompt } from "./codex-user-events.mjs";

const INPUT_BOUNDARIES = new Set(["user_message", "task_started", "task_complete", "turn_aborted"]);
const needsOriginRecord = prefix => prefix.type === "turn_context"
  || (prefix.type === "event_msg" && INPUT_BOUNDARIES.has(prefix.payloadType))
  || (prefix.type === "response_item" && prefix.payloadType === "message");
const narrative = event => event.type === "response_item" && (event.payload?.role === "assistant"
  || ["function_call", "custom_tool_call"].includes(event.payload?.type));

/** WHAT: Checks whether the window begins with an unattributed continuation. WHY: Keeps an already self-contained window from scanning older disk history. */
export function needsCodexDreamOrigin(events) {
  for (const event of events) {
    if (codexUserPrompt(event) !== null) return false;
    if (narrative(event)) return true;
  }
  return false;
}

/** WHAT: Reads the last still-open authored origin before a record boundary. WHY: Prevents raw tool-byte limits from losing exact input, retaining one prompt and its task context. */
export function readCodexDreamOrigin(file, beforeByteOffset, fd) {
  let activeId = null, context = null, origin = null;
  for (const record of readSearchRecords(file, { endByteOffset: beforeByteOffset })) {
    const prefix = record.raw && classifyCodexRecordPrefix(record.raw.slice(0, 512));
    if (record.skippedBytes) {
      // Unknown or potentially authored oversized rows cannot be silently crossed.
      const fdPrefix = readCodexRecordPrefix(fd, record.byteOffset);
      if (!fdPrefix || needsOriginRecord(fdPrefix)) throw new Error(`dream-history-origin-record-exhausted: byte ${record.byteOffset}`);
      continue;
    }
    if (prefix && !needsOriginRecord(prefix)) continue;
    let event;
    try { event = JSON.parse(record.raw); }
    catch { throw new Error(`dream-history-origin-invalid-record: byte ${record.byteOffset}`); }
    if (!event || typeof event !== "object") throw new Error("dream-history-origin-invalid-record: not an object");
    const kind = event.payload?.type;
    if (event.type === "turn_context" || (event.type === "event_msg" && kind === "task_started")) {
      const id = event.payload?.turn_id || null;
      if (id !== activeId && !(origin && !origin.turnId && !activeId)) origin = null;
      activeId = id;
      context = { event: { ...event, payload: { ...(event.type === "event_msg" ? { type: kind } : {}), turn_id: id } },
        byteOffset: record.byteOffset };
      if (origin && !origin.turnId) { origin.turnId = id; origin.context = context; }
    }
    if (codexUserPrompt(event) !== null) {
      event.__hash = createHash("sha1").update(record.raw).digest("hex").slice(0, 16);
      origin = { event, byteOffset: record.byteOffset, turnId: activeId, context };
    }
    if (event.type === "event_msg" && ["task_complete", "turn_aborted"].includes(kind)
        && (!event.payload.turn_id || event.payload.turn_id === activeId)) {
      origin = null; activeId = null; context = null;
    }
  }
  return origin;
}

/** WHAT: Returns original origin records only for the same continuing task. WHY: Prevents closed or unrelated tasks and quoted output from acquiring a fabricated user prompt. */
export function codexDreamOriginEvents(origin, events) {
  if (!origin) return [];
  for (const event of events) {
    if (codexUserPrompt(event) !== null) return [];
    if ((event.type === "turn_context" || (event.type === "event_msg" && event.payload?.type === "task_started"))
        && event.payload.turn_id && origin.turnId && event.payload.turn_id !== origin.turnId) return [];
    if (narrative(event)) break;
  }
  return [origin.context, origin].filter(Boolean).sort((a, b) => a.byteOffset - b.byteOffset).map(record => record.event);
}

