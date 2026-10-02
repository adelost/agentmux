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
  return [...iterateCodexUserEvents(events)];
}

/** WHAT: Streams the same logical input normalization. WHY: Lets journal search retain bounded candidates without a second decoder or whole-file array. */
export function* iterateCodexUserEvents(events) {
  let previous = null;
  for (const event of events) {
    const text = codexUserPrompt(event);
    if (text !== null) {
      const source = event.type;
      // Only coalesce the other encoding of an input before any output or task
      // boundary. Repeated inputs using the same encoding remain distinct.
      if (previous?.source !== source && previous?.text === text) continue;
      previous = { source, text };
      yield source === "event_msg" ? event : {
        ...event, type: "event_msg", payload: { type: "user_message", message: text },
      };
      continue;
    }
    if ((event.type === "event_msg" && ["task_started", "task_complete", "turn_aborted"].includes(event.payload?.type))
        || (event.type === "response_item" && (event.payload?.role === "assistant"
          || ["function_call", "custom_tool_call"].includes(event.payload?.type)))) previous = null;
    yield event;
  }
}

// Any user_message counts, even without text (an image-only prompt).
const isCodexPrompt = event => (event?.type === "event_msg" && event.payload?.type === "user_message")
  || codexUserPrompt(event) !== null;
const isCodexTokenUsage = event => event?.type === "token_usage_record"
  || (event?.type === "event_msg" && event.payload?.type === "token_count");
const isCodexTurnEnd = (event, kind) => event?.type === "event_msg" && event.payload?.type === kind;

// A prompt the provider refused before any model ran adds no context. On
// 2026-10-02 two prompts refused for an unsupported model voided lsrc:4's
// compact receipt, so switching away needed a compact on that same model.
/** WHAT: Tracks whether each Codex prompt reached a model. WHY: Keeps refused prompts from counting as work. */
export function codexPromptProgress() {
  let open = false;
  return {
    see(event) {
      if (isCodexPrompt(event)) { open = true; return "prompt"; }
      if (!open) return null;
      // An aborted turn may have run a model without logging usage yet: count it.
      if (isCodexTokenUsage(event) || isCodexTurnEnd(event, "turn_aborted")) { open = false; return "processed"; }
      if (isCodexTurnEnd(event, "task_complete")) { open = false; return "refused"; }
      return null;
    },
    // A compaction folds the open prompt into its summary.
    settle() { open = false; },
    isOpen: () => open,
  };
}
