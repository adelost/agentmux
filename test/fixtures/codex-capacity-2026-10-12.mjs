// Sanitized lsrc:5 evidence. Original task_complete is line 20381; preceding
// usage fields and prompt text are omitted. Provider error is verbatim.
export const capacityError = "Selected model is at capacity. Please try a different model.";
export const capacityEvents = [
  { timestamp: "2026-10-12T07:08:00.000Z", type: "event_msg", payload: { type: "user_message", message: "Continue the assigned task." } },
  { timestamp: "2026-10-12T07:08:00.001Z", type: "event_msg", payload: { type: "task_started", turn_id: "01a12ef1-69fa-70a3-9fbe-3d7994a8d712" } },
  { timestamp: "2026-10-12T07:10:03.432Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 9 } } } },
  { timestamp: "2026-10-12T07:10:03.473Z", type: "event_msg", payload: { type: "task_complete", turn_id: "01a12ef1-69fa-70a3-9fbe-3d7994a8d712", last_agent_message: null } },
];
