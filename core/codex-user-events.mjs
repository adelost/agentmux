// Normalize authored Codex inputs in memory only. Rollouts remain untouched.

/** WHAT: Extracts exact authored input from supported Codex event formats. WHY: Keeps environment instructions and quoted/tool text out of delivery receipts. */
export function codexUserPrompt(event) {
  const payload = event?.payload;
  if (event?.type === "event_msg" && payload?.type === "user_message") {
    return typeof payload.message === "string" ? payload.message : null;
  }
  if (event?.type !== "response_item" || payload?.type !== "message" || payload.role !== "user") return null;
  const content = payload.content;
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  // Modern rollouts mark real input separately from AGENTS/environment blocks.
  // Unsupported/untyped records are not proof, even if they quote the prompt.
  if (!Array.isArray(content) || content.length === 0 || !Array.isArray(kinds)
      || kinds.length !== content.length || kinds.some((kind) => kind !== "user.text")
      || content.some((block) => block.type !== "input_text" || typeof block.text !== "string")) return null;
  return content.map((block) => block.text).join("\n");
}

/** WHAT: Maps supported input records to one logical prompt boundary. WHY: Prevents dual-format journals from doubling turns while preserving repeated authored prompts. */
export function normalizeCodexUserEvents(events) {
  const result = [];
  let previous = null;
  for (const event of events) {
    const text = codexUserPrompt(event);
    if (text !== null) {
      const source = event.type;
      // Only coalesce the other encoding of an input before any output or task
      // boundary. Repeated inputs using the same encoding remain distinct.
      if (previous?.source !== source && previous?.text === text) continue;
      previous = { source, text };
      result.push(source === "event_msg" ? event : {
        ...event, type: "event_msg", payload: { type: "user_message", message: text },
      });
      continue;
    }
    if ((event.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(event.payload?.type))
        || (event.type === "response_item" && (event.payload?.role === "assistant"
          || ["function_call", "custom_tool_call"].includes(event.payload?.type)))) previous = null;
    result.push(event);
  }
  return result;
}
