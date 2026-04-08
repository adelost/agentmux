// Dialects: data-driven description of the tmux-based coding agents we support.
// Each dialect is a plain object. Extract/noise/agent read from this data —
// there should be no hardcoded "if claude / if codex" branches elsewhere.
//
// To add a new dialect (Aider, Gemini CLI, etc.) create a new object here
// and add it to ALL_DIALECTS. Nothing else needs to change.

// --- Claude Code ---------------------------------------------------------

export const CLAUDE = {
  name: "claude",

  // UI glyphs
  promptChar: "❯",         // user prompt marker
  bullet: "●",              // response bullet (text or tool call)
  toolResultPrefix: "⎿",   // tool-output continuation prefix

  // Tool call pattern: "● Bash(cmd)", "● Read 3 files", "● Wrote 45 lines"
  toolCallPattern: /^● (?:[A-Za-z]+\(|Searched for \d|Wrote \d|Read \d|Edit \d)/,

  // isBusy behavior: Claude's ❯ prompt is empty when idle, has text when typing
  idleWhenPromptEmpty: true,

  // Substrings that indicate the agent is actively working.
  // Narrow panes may truncate "esc to interrupt" to "esc to interrup" —
  // "interrup" is included for that case. ✻ / Doing… cover the pre-response
  // thinking phase where interrupt text hasn't rendered yet.
  busySignals: ["esc to interrup", "✻ ", "Doing…"],

  // Banners/noise specific to Claude Code
  noise: [
    /^\s*[▐▛▝▜▘█▌▙▟]{2}/,                    // banner box drawing
    /^Claude Code v[\d.]+/,
    /^(Opus|Sonnet|Haiku|Claude) [\d.]+ ·/,
    /^-dangerously-skip-permissions/,
    /How is Claude doing/,                     // feedback survey
    /^\s+\d+: (Bad|Fine|Good|Dismiss)/,        // survey options
    /^\s*\d+\s+tokens\s*$/,                    // v2.1.96 bottom status: "27257 tokens"
    /^\s*● (high|medium|low) · \/effort\s*$/,  // v2.1.96 effort indicator
  ],
};

// --- Codex ---------------------------------------------------------------

export const CODEX = {
  name: "codex",

  promptChar: "›",
  bullet: "•",
  toolResultPrefix: "└",

  // Codex tool calls are verb-prefixed: "• Ran date", "• Explored", "• Read file"
  toolCallPattern: new RegExp(
    "^• (?:" +
    "Explored|Ran|Read|Wrote|Edit|Edited|Update|Updated|" +
    "Search|Searched|List|Listed|View|Viewed|Create|Created|Delete|Deleted" +
    ")\\b"
  ),

  // Codex shows a placeholder ("Find and fix a bug in @filename") in the prompt
  // even when idle, so prompt-has-text is NOT a reliable busy signal.
  idleWhenPromptEmpty: false,

  // Codex busy indicators. "esc to interrup" catches truncation on narrow panes.
  busySignals: ["esc to interrup", "• Working ("],

  noise: [
    /^>_ OpenAI Codex/,                          // startup banner
    /^gpt-[\d.]+ \w+ ·/,                          // top status: "gpt-5.4 xhigh · 99% left"
    /^\s*gpt-[\d.]+ \w+ · \d+% left/,            // bottom status (indented variant)
    /^model:\s/,                                  // config line
    /^directory:\s/,                              // config line
    /^╭|^╰|^│/,                                  // box drawing
    /^Tip: /,                                    // tips
    /^\s*• Working \(/,                           // busy indicator
  ],
};

// --- Registry ------------------------------------------------------------

export const ALL_DIALECTS = [CLAUDE, CODEX];

/**
 * Identify which dialect produced this raw tmux buffer.
 * Checks the tail first (recent content) since scrollback may contain old banners.
 */
export function detectDialect(raw) {
  // Strong signal: Codex banner somewhere
  if (raw.includes(">_ OpenAI Codex")) return CODEX;
  // Last prompt char in the tail
  const tail = raw.split("\n").slice(-15);
  for (const line of tail) {
    const trimmed = line.trim();
    for (const d of ALL_DIALECTS) {
      if (trimmed.startsWith(d.promptChar)) return d;
    }
  }
  return CLAUDE; // default
}

// --- Cross-dialect line matchers -----------------------------------------
// These match lines against ANY dialect's patterns. Useful for line-level
// classification where we don't know (or care) which dialect produced the line.

/** True if a line starts with any dialect's bullet glyph. */
export const matchesAnyBullet = (line) =>
  ALL_DIALECTS.some((d) => line.startsWith(d.bullet + " "));

/** True if a line starts with any dialect's tool-result prefix (with optional whitespace). */
export const matchesAnyToolResult = (line) =>
  ALL_DIALECTS.some((d) => new RegExp(`^\\s*${d.toolResultPrefix}`).test(line));

/** True if a line matches any dialect's tool-call pattern. */
export const matchesAnyToolCall = (line) =>
  ALL_DIALECTS.some((d) => d.toolCallPattern.test(line));

/** True if a line starts with any dialect's prompt marker followed by text or space. */
export const matchesAnyPromptPrefix = (line) =>
  ALL_DIALECTS.some((d) => line.startsWith(d.promptChar + " "));

/** True if a line starts with any dialect's user prompt (non-empty). */
export const matchesAnyPromptWithText = (line) =>
  ALL_DIALECTS.some((d) => new RegExp(`^${d.promptChar} \\S`).test(line));

/** Strip any dialect's leading bullet (and following space) from a line. */
export const stripBullet = (line) => {
  for (const d of ALL_DIALECTS) {
    if (line.startsWith(d.bullet + " ")) return line.slice(d.bullet.length + 1);
    if (line.startsWith(d.bullet)) return line.slice(d.bullet.length);
  }
  return line;
};
