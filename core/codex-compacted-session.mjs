import { statSync } from "node:fs";
import { jsonlEventsAfterCursor } from "./jsonl-append-cursor.mjs";
import { isCodexCompaction } from "./codex-compaction.mjs";
import { codexUserPrompt } from "./codex-user-events.mjs";

/** WHAT: Checks an exact rollout's native compact boundary without changing its receipt.
 * WHY: Prevents a compact-only migrated session from requiring another paid compact or an invented idle time. */
export function isCompactedCodexSession(identity) {
  if (!identity?.path) return false;
  let before;
  try { before = statSync(identity.path); } catch { return false; }
  if (before.size > 8 * 1024 * 1024) return false;
  const events = jsonlEventsAfterCursor([identity.path], { positions: { [identity.path]: 0 } });
  if (events[0]?.type !== "session_meta" || events[0].payload?.id !== identity.sessionId) return false;
  let compacted = false;
  for (const event of events) {
    if (isCodexCompaction(event)) compacted = true;
    else if (codexUserPrompt(event) || (event.type === "event_msg" && ["task_started", "agent_message"].includes(event.payload?.type))
      || (event.type === "response_item" && ["message", "function_call", "custom_tool_call"].includes(event.payload?.type))) compacted = false;
  }
  const after = statSync(identity.path);
  return compacted && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ino === after.ino;
}
