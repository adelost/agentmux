// UI noise patterns shared across all tmux-based agents.
// Dialect-specific patterns (Claude banner, Codex status bar, etc.)
// live in ./dialects.mjs — this file only holds cross-cutting noise.

import { ALL_DIALECTS, matchesAnyToolCall } from "./dialects.mjs";

// --- Shared noise (applies to every dialect) ----------------------------

export const SHARED_NOISE = [
  /^[─━═▪ ]{3,}$/,                            // horizontal separators
  /^[❯›]/,                                      // any prompt marker line
  /^[✻✢✽✶✷✸✹✺✿❋⚙◉∗⊛·˙] /,                  // thinking animation
  /^[A-Z][\w-]*(?:ing|ed)…/,                    // "Musing…", "Topsy-turvying… (4s)"
  /thinking with high effort/,
  /thought for \d+s/,
  /^[A-Z][a-z]+ for \d+[ms] /,                  // "Cogitated for 14s ..."
  /💡 agent log/,
  /bypass permissions/,
  /esc to interrupt/,
  /Enter to select/,
  /Esc to cancel/,
  /Allow once|Allow always/,
  /^\s*ctrl\+o to expand/,
  /^(Read|Wrote|Edit|Searched for) \d+.+\(ctrl/,
  /^cd \//,
  /^conda:/,
  /^Overriding existing handler/,
  /^Set JSC_SIGNAL/,
  /^\w+@\S+[:\$]/,                             // shell prompt (user@host)
  /Press enter to continue/,
  /Do you trust the contents/,
  /bubblewrap/,
  /^~\//,
  /^context: \d+%/,
  /^\[(image|file) attached:/,                  // injected attachment paths
];

// --- Unified noise check -------------------------------------------------

// All patterns from every dialect, flattened once.
const DIALECT_NOISE = ALL_DIALECTS.flatMap((d) => d.noise);

/** True if a line is UI noise from any known dialect or the shared list. */
export const isNoise = (line) =>
  SHARED_NOISE.some((p) => p.test(line)) ||
  DIALECT_NOISE.some((p) => p.test(line));

// --- Tool-call detection -------------------------------------------------

/** True if a line is a tool-call start line for any dialect. */
export const isToolCall = (line) => matchesAnyToolCall(line);

// Legacy alias: some tests/code imports TOOL_CALL as a regex. Wrap it in a
// fake RegExp-like object with .test() that delegates to isToolCall.
// Prefer importing isToolCall directly in new code.
export const TOOL_CALL = { test: (line) => isToolCall(line) };
