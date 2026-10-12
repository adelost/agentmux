// Sanitized lsrc:9 lifecycle, preserving actual timestamps and turn identities.
// The SQLite capacity error belongs to 12:39. The 13:08 end is a successful
// explicit compact, not a second capacity error or authored input.
export const compactedCapacityThread = "01a12ff1-bd30-7d72-bffe-5f51ef251327";
export const compactedCapacityTurn = "01a13017-f25b-7723-bd8b-52f3e9b29db5";
export const compactedCapacityEvents = [
  { timestamp: "2026-10-12T12:36:29.521Z", type: "response_item", payload: {
    type: "message", role: "user", content: [{ type: "input_text", text: "Continue the assigned task." }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
  } },
  { timestamp: "2026-10-12T12:39:42.212Z", type: "event_msg", payload: {
    type: "task_complete", turn_id: compactedCapacityTurn, last_agent_message: null,
  } },
  { timestamp: "2026-10-12T13:05:33.951Z", type: "event_msg", payload: {
    type: "task_started", turn_id: "01a13037-ecfb-7a80-a4a9-4a10053bcbc9",
  } },
  { timestamp: "2026-10-12T13:08:26.716Z", type: "compacted", payload: { message: "Saved task context." } },
  { timestamp: "2026-10-12T13:08:26.716Z", type: "turn_context", payload: {
    turn_id: "01a13037-ecfb-7a80-a4a9-4a10053bcbc9", model: "gpt-6.1-sol", effort: "xhigh",
  } },
  { timestamp: "2026-10-12T13:08:26.728Z", type: "event_msg", payload: {
    type: "task_complete", turn_id: "01a13037-ecfb-7a80-a4a9-4a10053bcbc9", last_agent_message: null,
  } },
];
