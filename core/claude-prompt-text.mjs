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

// Claude Code 2.1.296 stores each paste as "\n\n<pasted_content id=\"abcd\">\n" + body +
// "\n</pasted_content id=\"abcd\">\n" and reads a message back (its xDt/cwe) by joining every body
// with the text around it, nothing in between. amux pastes a Claude message in parts
// (claudeSafePasteParts), so one message can arrive as several envelopes split mid-word: job
// 73d6862d to skyvw:0 on 2026-10-10 got no receipt, was pasted again and held the queue.
const PASTE_OPEN = '<pasted_content id="';
const PASTE_ID_RE = /^[0-9a-f]{4}$/u;

/** WHAT: Unwraps every complete Claude paste envelope as Claude reads it. WHY: Keeps a message pasted in parts from reading as undelivered. */
function unwrapPastedContent(text) {
  let read = "";
  let from = 0;
  let scan = 0;
  for (;;) {
    const open = text.indexOf(PASTE_OPEN, scan);
    if (open === -1) break;
    const idAt = open + PASTE_OPEN.length;
    const id = text.slice(idAt, idAt + 4);
    if (!PASTE_ID_RE.test(id) || !text.startsWith('">\n', idAt + 4)) {
      scan = idAt;
      continue;
    }
    const bodyAt = idAt + 7;
    const closer = `\n</pasted_content id="${id}">`;
    const close = text.indexOf(closer, bodyAt - 1);
    if (close === -1) break;
    let start = open;
    for (let n = 0; n < 2 && start > from && text[start - 1] === "\n"; n++) start--;
    read += text.slice(from, start) + text.slice(bodyAt, close);
    from = close + closer.length;
    for (let n = 0; n < 2 && text[from] === "\n"; n++) from++;
    scan = from;
  }
  return read + text.slice(from);
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
  // They go after unwrapping: a message pasted in parts splits its image
  // path across an envelope boundary ("390." | "png").
  // Claude's paste renderer removes discretionary soft hyphens (U+00AD).
  // Match that observed layout-only rewrite, not ordinary hyphens or joiners.
  let s = unwrapPastedContent(String(text).replace(/\u00ad/g, "").replace(/\r\n?/g, "\n"))
    .replace(/\[Image #\d+\]/g, " ")
    .replace(/(?<!\S)[~/]\S*\.(?:png|jpe?g|gif|webp)(?!\S)/gi, " ")
    .trim();
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
