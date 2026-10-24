// Native tool envelopes are retained as audit evidence; script bodies are never interpreted.
const strings = (value, out = []) => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, out));
  return out;
};

// Codex function arguments are a JSON string; quotes inside a note are escaped there.
const decoded = (value) => {
  if (typeof value !== "string") return value;
  try { return [value, JSON.parse(value)]; } catch { return value; }
};

/** WHAT: Returns the text one journal event typed into tools. WHY: Keeps a pane that merely read the daily file from counting as its writer. */
export function toolCallTexts(event, { includeCalls = false } = {}) {
  const blocks = event?.type === "assistant" && Array.isArray(event.message?.content) ? event.message.content : [];
  const claude = blocks.filter((block) => block?.type === "tool_use").flatMap((block) => strings(block.input));
  const payload = event?.type === "response_item" ? event.payload : null;
  const codex = ["function_call", "custom_tool_call", "local_shell_call"].includes(payload?.type)
    ? strings([decoded(payload.arguments), payload.input, payload.action]) : [];
  if (!includeCalls) return [...claude, ...codex];
  const calls = blocks.filter(block => block?.type === "tool_use")
    .map(block => ({ tool: block.name || "unknown", input: block.input }));
  if (["function_call", "custom_tool_call", "local_shell_call"].includes(payload?.type)) {
    const input = payload.arguments ?? payload.input ?? payload.action;
    const parsed = decoded(input);
    calls.push({ tool: payload.name || payload.type, input: typeof input === "string" && Array.isArray(parsed) ? parsed[1] : parsed });
  }
  return calls.map(call => JSON.stringify(call));
}
