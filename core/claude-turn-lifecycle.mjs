// Claude's explicit turn boundary is distinct from a tool result or quoted text.

/** WHAT: Reads a Claude user prompt. WHY: Prevents tool-result arrays from becoming new human turns. */
export function userPromptText(event) {
  if (event?.type !== "user") return null;
  const content = event.message?.content;
  return typeof content === "string" ? content : null;
}

/** WHAT: Checks Claude's exact interruption record. WHY: Prevents ordinary errors and quoted output from authorizing idle recovery. */
function isInterruption(event) {
  const content = event?.message?.content;
  return event?.type === "user" && Array.isArray(content) && content.length === 1
    && content[0]?.type === "text" && typeof content[0].text === "string"
    && /^\[Request interrupted by user(?: for tool use)?\]$/.test(content[0].text);
}

/** WHAT: Reads the lifecycle after one accepted prompt. WHY: Prevents a cancelled tool turn from remaining busy until an unrelated background job finishes. */
export function readClaudeTurnLifecycle(events, userIdx) {
  let lastAssistant = null;
  let pendingToolResult = false;
  let nextTurnExists = false;
  let interrupted = false;
  for (let i = userIdx + 1; i < events.length; i++) {
    const event = events[i];
    if (isInterruption(event)) {
      interrupted = true;
      pendingToolResult = false;
      continue;
    }
    if (event.type === "user") {
      interrupted = false;
      if (userPromptText(event) !== null) { nextTurnExists = true; break; }
      pendingToolResult = true;
      continue;
    }
    if (event.type !== "assistant") continue;
    lastAssistant = event;
    pendingToolResult = false;
    interrupted = false;
  }
  return { lastAssistant, pendingToolResult, nextTurnExists, interrupted };
}
