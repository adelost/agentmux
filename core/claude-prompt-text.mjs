// Compare a sent prompt with the text Claude Code records in its session JSONL.

/** WHAT: Extracts prompt text from one Claude JSONL event. WHY: Prevents a receipt stored as a queue record from reading as undelivered. */
export function extractPromptFromEvent(event) {
  // Claude Code records the same prompt in several places depending on timing:
  //   { type: "user", message: { content } }                   direct user event
  //   { type: "queue-operation", operation: "enqueue", content } sent while busy
  //   { type: "attachment", attachment: { type: "queued_command", prompt } }
  // All three are legitimate "agent received the prompt" signals.
  if (!event) return null;
  if (event.type === "user") return promptContentText(event.message?.content);
  if (event.type === "queue-operation" && event.operation === "enqueue" && typeof event.content === "string") {
    return event.content;
  }
  if (event.type === "attachment" && event.attachment?.type === "queued_command") {
    return promptContentText(event.attachment.prompt);
  }
  return null;
}

// A pasted image path turns Claude's record into text parts plus image parts.
function promptContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((part) => part?.type === "text" && typeof part.text === "string");
  return texts.length ? texts.map((part) => part.text).join("\n") : null;
}

/** WHAT: Unwraps one complete Claude paste envelope. WHY: A received paste must acknowledge without accepting quoted substrings or mismatched IDs. */
function unwrapPastedContent(text) {
  const pasted = text.trim().match(/^<pasted_content id="([^"\r\n]+)">\s*([\s\S]*?)\s*<\/pasted_content id="\1">$/u);
  return pasted ? pasted[2] : text;
}

/** WHAT: Extracts the comparable core of a prompt. WHY: Sender envelopes and Claude's paste rewrites must not hide a receipt. */
export function normalizePrompt(text) {
  // Stripped from both sides: "[from agent:N]" envelopes, the voice-PWA
  // disclaimer, the TTS hint suffix, "[Image #N]" markers with image file
  // paths, and whitespace differences. Without this an exact-match search
  // misses turns where one side gained decoration, and delivery receipts or
  // response extraction fall through to tmux scraping.
  if (!text) return "";
  // Pasted image paths: Claude attaches some and keeps others as text, and
  // puts "[Image #N]" first, so both sides drop markers and image paths.
  // They go before unwrapping: a marker ahead of a paste envelope must not
  // hide the envelope.
  let s = String(text).replace(/\r\n?/g, "\n")
    .replace(/\[Image #\d+\]/g, " ")
    .replace(/(?<!\S)[~/]\S*\.(?:png|jpe?g|gif|webp)(?!\S)/gi, " ");
  s = unwrapPastedContent(s).trim();
  // ax-meta: "[from project:0] actual prompt". Strip repeated envelopes too:
  // a caller may already include provenance and the CLI then adds its own.
  s = s.replace(/^(?:\[from\s+[^:]+:\d+\]\s*)+/i, "");
  s = s.replace(/^\[transcribed voice[^\]]*\]\s*/i, "");
  s = s.replace(/\s*\n\s*\[tts on[^\]]*\]\s*$/i, "");
  return s.replace(/\s+/g, " ").trim();
}

/** WHAT: Checks whether one JSONL event records the prompt. WHY: Decides delivery receipts without trusting the terminal. */
export function promptEventMatches(event, promptText) {
  const needle = promptText?.trim();
  if (!needle) return false;
  const text = extractPromptFromEvent(event);
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed === needle) return true;
  const fuzzyNeedle = normalizePrompt(needle);
  return Boolean(fuzzyNeedle && normalizePrompt(trimmed) === fuzzyNeedle);
}

/** WHAT: Checks whether any event records the prompt. WHY: Keeps receipt scans on one matching rule. */
export function promptAppearsInEvents(events, promptText) {
  return events.some((event) => promptEventMatches(event, promptText));
}
