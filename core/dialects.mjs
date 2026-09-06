// Dialects: data-driven description of the tmux-based coding agents we support.
// Each dialect is a plain object. Extract/noise/agent read from this data.
// There should be no hardcoded "if claude / if codex" branches elsewhere.
//
// To add a new dialect (Aider, Gemini CLI, etc.) create a new object here
// and add it to ALL_DIALECTS. Nothing else needs to change.

// --- Claude Code ---------------------------------------------------------

// All progress/thinking icons Claude Code rotates through while working.
// Observed variants: ✻ Musing, ✢ Frolicking, ✽ ..., · Orchestrating, * Waddling,
// ∗ Cogitating, ◉, ⚙, ❋, and more. The UI picks one and rotates.
//
// The literal ellipsis `…` is the busy marker, the present-progressive phase.
// Past-tense completion lines ("✻ Worked for 32s", "✻ Cogitated for 14s",
// "✻ Brewed for 2s") do NOT have … and mean the agent is DONE. If we matched
// those as busy we'd hang forever waiting for something that already finished.
const CLAUDE_PROGRESS_ICONS = "✻✢✽✶✷✸✹✺✿❋⚙◉∗⊛·˙*";
const CLAUDE_PROGRESS_LINE = new RegExp(`^[${CLAUDE_PROGRESS_ICONS}] [A-Z][a-z]+ing…`);
const CLAUDE_PROGRESS_LINE_ANY = new RegExp(`(^|\\s)[${CLAUDE_PROGRESS_ICONS}] [A-Z][a-z]+ing…`, "m");
// Past-tense completion lines are noise (they appear briefly after the turn ends)
const CLAUDE_COMPLETED_LINE = new RegExp(`^[${CLAUDE_PROGRESS_ICONS}] [A-Z][a-z]+ed for \\d`);

/** WHAT: Defines the Claude TUI dialect. WHY: Keeps transport acknowledgement separate from compaction completion. */
export const CLAUDE = {
  name: "claude",

  // A consumed slash may answer "Not enough messages to compact". Only the
  // journal boundary/summary proves completion, never the transport ACK.
  compactReceiptIsAuthoritative: false,

  // UI glyphs
  promptChar: "❯",         // user prompt marker
  bullet: "●",              // response bullet (text or tool call)
  toolResultPrefix: "⎿",   // tool-output continuation prefix

  // Tool call pattern: "● Bash(cmd)", "● Read 3 files", "● Wrote 45 lines"
  toolCallPattern: /^● (?:[A-Za-z]+\(|Searched for \d|Wrote \d|Read \d|Edit \d)/,

  // isBusy behavior: Claude's ❯ prompt is empty when idle, has text when typing
  idleWhenPromptEmpty: true,

  // Signals that the agent is actively working. Entries may be strings
  // (substring match) or RegExp (pattern match).
  //   - "esc to interrup": covers truncation on narrow panes (missing "t")
  //   - CLAUDE_PROGRESS_LINE_ANY: catches every thinking/progress phase:
  //     "✻ Musing… (2s)", "· Orchestrating…", "* Waddling…", "✢ Frolicking…"
  busySignals: [
    "esc to interrup",
    CLAUDE_PROGRESS_LINE_ANY,
  ],

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
    CLAUDE_PROGRESS_LINE,                      // active progress: "✻ Musing…"
    CLAUDE_COMPLETED_LINE,                      // completed progress: "✻ Worked for 32s"
  ],

  // Modal dialogs, in the priority order detectPaneStatus must report them.
  // These are exactly the strings format.mjs matched before recognition moved
  // into the registry; keep array order stable.
  modals: [
    { id: "permission", status: "permission", re: /Allow once|Allow always|Do you want to proceed/ },
    { id: "menu", status: "menu", re: /Enter to select|Esc to cancel/ },
    { id: "resume", status: "resume", re: /Resume from summary/ },
    { id: "dismiss", status: "dismiss", re: /0: Dismiss/ },
  ],
};

// --- Codex ---------------------------------------------------------------

/** WHAT: Defines the Codex TUI dialect. WHY: Keeps Codex screen parsing from leaking into engine-neutral code. */
export const CODEX = {
  name: "codex",

  compactReceiptIsAuthoritative: false,

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

  // Codex shows a placeholder ("Ask Codex to do anything") in the prompt
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

  // No Codex choice-modals are scrape-recognized today; the interrupted-turn
  // banner is a status, not a modal, and stays in detectPaneStatus.
  modals: [],
};

// --- Kimi Code ------------------------------------------------------------

/** WHAT: Describes Kimi TUI markers. WHY: Keeps parsing independent from Claude and Codex rendering. */
export const KIMI = {
  name: "kimi",

  compactReceiptIsAuthoritative: false,

  promptChar: ">",
  bullet: "◆",
  toolResultPrefix: "│",
  toolCallPattern: /^◆ (?:Run|Read|Write|Edit|Search|Fetch|Use)\b/u,

  // The Kimi composer is an empty `> ` row while idle.
  idleWhenPromptEmpty: true,
  busySignals: ["esc to interrup", "Ctrl-C to interrupt"],

  noise: [
    /^Welcome to Kimi Code/u,
    /^Session\s+session_[0-9a-f-]+/iu,
    /^Model\s+/u,
    /^Version\s+[\d.]+/u,
    /^\s*(?:yolo|auto|plan)\s+\S+\s+~/iu,
    /^\s*context:\s*\d+(?:\.\d+)?%/iu,
  ],

  // The boxed composer row ("│ > │"). Kimi keeps it visible while a turn
  // runs, so presence never proves idle — but ABSENCE proves the editor was
  // replaced by a dialog (mountEditorReplacement). detectPaneStatus uses it
  // as the modal veto line.
  promptLineRe: /^\s*(?:[│┃]\s*)?>\s*(?:[│┃]\s*)?$/mu,

  // Startup/send-time dialogs. The veto contract (modalVetoLineRe) matters
  // because these dialogs render their selected option with a "❯" pointer —
  // textually a Claude composer line — which is why Kimi modals are checked
  // before the prompt-first idle return, gated on composer absence. Patterns
  // are title + option-label compounds so a pane merely discussing one title
  // string does not match (verified against the 0.34.0 dialog renders: the
  // trust dialog has no footer; the cache hint always pairs its title with
  // the "Compact and continue" option).
  modals: [
    { id: "workspace-trust", status: "menu", re: /Trust this folder\?[\s\S]*Don't trust/u },
    { id: "cache-expiry-hint", status: "menu", re: /Cache expired[\s\S]*Compact and continue/u },
  ],
  modalVetoLineRe: /^\s*(?:[│┃]\s*)?>\s*(?:[│┃]\s*)?$/mu,
};

// --- Registry ------------------------------------------------------------

/** WHAT: Defines supported TUI dialects. WHY: Keeps fallback detection aligned with every engine. */
export const ALL_DIALECTS = [CLAUDE, CODEX, KIMI];

// A new engine opts OUT by staying off the registry, never in by editing a
// call site. dialectFor returns null for shell panes, which is what the
// /compact gates reject.
/**
 * WHAT: Reports whether a resolved dialect name belongs to a registered coding agent.
 * WHY: Keeps slash-command gates from excluding a registered engine the way
 * hardcoded claude/codex lists silently excluded Kimi.
 */
export const isCodingDialect = (dialect) =>
  ALL_DIALECTS.some((entry) => entry.name === dialect);

/**
 * WHAT: Reports whether a dialect's `/compact` acknowledgement may be announced
 * as completion.
 * WHY: Auto-compact used to answer this with a hardcoded engine list at the call
 * site, which is exactly how Kimi was silently excluded from compaction
 * altogether and grew to 83% context untouched. The capability belongs to the
 * registry so a registered engine cannot be dropped by editing a call site.
 */
export const compactReceiptIsAuthoritative = (dialect) =>
  ALL_DIALECTS.find((entry) => entry.name === dialect)?.compactReceiptIsAuthoritative === true;

/**
 * WHAT: Resolves the dialect producing a tmux buffer.
 * WHY: Keeps scrollback parsing from applying another engine's markers.
 */
export function detectDialect(raw) {
  if (raw.includes("Welcome to Kimi Code") || /\bSession\s+session_[0-9a-f-]+/iu.test(raw)) return KIMI;
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

// Composer-line marker: matches a rendered input line of ANY dialect
// ("❯ text" claude, "› text" codex, "> text" legacy). Built from dialect
// data so a new dialect's promptChar is covered automatically — a
// hardcoded /^[❯>]/ missed codex's "›", which made idempotent-retry
// re-TYPE a brief already sitting in a codex composer (the "][…" garbage
// class, ai:4 2026-07-08).
export const COMPOSER_LINE_RE = new RegExp(
  `^[>${ALL_DIALECTS.map((d) => d.promptChar).join("")}]`,
);

/**
 * Text a previous (failed) delivery left in the composer that would corrupt
 * the message we're about to type. Returns the stale text, or null when
 * typing is safe. Pure — callers own the capture + clearing keystrokes.
 *
 * Guards, in order:
 *   - only composer lines count (dialect prompt marker) — a prompt quoted
 *     in scrollback must not trigger clearing
 *   - our own prompt head → null (idempotent retry; caller skips typing)
 *   - short unbracketed text → null: codex renders a short placeholder hint
 *     on the idle composer line, and a human's half-typed draft should be
 *     preserved. The garbage class this kills is LONG stale briefs (ai:4
 *     2026-07-08: "][ai:2, BINDANDE …" submitted 13 minutes late as noise),
 *     and every amux brief is bracket-prefixed ("[from x]", "[keeper …]").
 */
export function foreignComposerText(raw, promptHead) {
  const lines = String(raw || "").split("\n").map((l) => l.trim());
  const composer = lines.filter((l) => COMPOSER_LINE_RE.test(l)).pop();
  if (!composer) return null;
  const text = composer.replace(COMPOSER_LINE_RE, "").trim();
  if (!text) return null;
  if (promptHead && text.includes(promptHead)) return null;
  if (!text.startsWith("[") && text.length < 80) return null;
  return text;
}
