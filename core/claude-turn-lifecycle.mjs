// Claude's explicit turn boundary is distinct from a tool result or quoted text.

// stop_reasons that mean "claude is done with this turn".
//
// IMPORTANT: max_tokens is NOT terminal in agentic Claude Code. When claude
// hits its per-message output budget mid-thought, it stops with max_tokens
// and then immediately continues in a fresh assistant message. Same turn,
// same user prompt. Treating max_tokens as terminal causes agentmux to bail
// halfway through long turns (observed on the "plocka ut" turn: extract
// grabbed 14 items when the real turn had 20+ and ended with end_turn).
//
// Anything NOT in this set means claude is still working:
//   null / undefined  = streaming in progress
//   "tool_use"        = pausing for a tool result
//   "max_tokens"      = budget hit, will continue automatically
/** WHAT: Defines terminal Claude stop reasons. WHY: Keeps activity and history completion from disagreeing about max_tokens continuations. */
export const CLAUDE_TERMINAL_STOP_REASONS = new Set(["end_turn", "stop_sequence", "refusal"]);

/** WHAT: Reads a Claude user prompt. WHY: Prevents tool-result arrays from becoming new human turns. */
export function userPromptText(event) {
  if (event?.type !== "user") return null;
  const content = event.message?.content;
  return typeof content === "string" ? content : null;
}

/** WHAT: Checks an engine-only background notification. WHY: A failed child can report after a quota stop without starting another model turn. */
export function isClaudeTaskNotification(event) {
  const text = userPromptText(event);
  return event?.origin?.kind === "task-notification" && event.promptSource === "system"
    && text !== null && /^\s*<task-notification>[\s\S]*<\/task-notification>\s*$/.test(text);
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
