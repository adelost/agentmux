// WHAT: The canonical predicate for machine-generated "user" turns — slash-
//       command wrappers, compact continuations, hook banners — that must
//       never be read as a human directive or an open ask.
// WHY: Three surfaces (amux done's directive ring, the needs-you classifier,
//      amux asks) each grew their own partial filter, and the gaps let a
//      /compact wrapper render as "senast ombedd" for a pane (SRC-0053).
//      One shared definition means the surfaces can never drift apart again.
// DOES NOT: Judge whether HUMAN text is important — only whether the turn is
//           machine-authored plumbing. Inter-agent briefs ("[from project:2]...")
//           and cron briefs ("[dream ...]") are real directives, never noise.
import { unwrapPastedContent } from "./claude-prompt-text.mjs";

// Union of the two predicates this module replaced (cli/commands.mjs local +
// core/resume-hint.mjs inline) plus the live-repro gaps: a PLAIN "/compact"
// turn and the [amux ... hint] markers.
const NOISE_PATTERNS = [
  // Slash-command wrappers: the CLI logs "/compact" etc. as a user turn...
  /^<(local-command|command-name|command-message|command-args|command-stdout|command-stderr|command-contents)\b/i,
  // ...and sometimes as the bare command itself.
  /^\/(?:compact(?:\s|$)|model\s*$)/,
  /^\[amux (resume|compact) hint\]/i,
  /^\[AMUX AUTOMATIC QUOTA RECOVERY\b/i,
  /^\[AMUX AUTOMATIC CRASH RECOVERY\b/i,
  /^\[drift-guard\]/i,
  /^Caveat:/,
  // Post-compact continuation preamble injected by the harness, not typed.
  /^This session is being continued from a previous conversation/,
  // Hook/system banners that arrive on the user channel (<system-reminder> etc).
  /^<system-/i,
  /^<task-notification\b/i,
  /^\[Request interrupted/,
];

/** WHAT: Returns the authored content of one complete engine paste envelope. WHY: Classifies and matches observations without rewriting their saved verbatim text. */
export function authoredPromptText(text) {
  const value = String(text || "").trim();
  return unwrapPastedContent(value).trim();
}

/**
 * WHAT: Returns whether a user-role input is machine plumbing or empty.
 * WHY: Keeps notifications and wrappers from becoming human directives.
 */
export function isSystemNoiseDirective(text) {
  const head = authoredPromptText(text);
  if (!head) return true;
  return NOISE_PATTERNS.some((pattern) => pattern.test(head));
}

/** WHAT: Checks whether a directive proves active work. WHY: Prevents maintenance from waking an otherwise sleeping pane. */
export function isWorkDirective(text) {
  const head = String(text || "").trimStart();
  return !isSystemNoiseDirective(head) && !/^\[(?:amux\s+)?dream\b/i.test(head);
}
