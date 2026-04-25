// Blocking prompt recognition and dismissal for Claude/Codex panes.
// These dialogs occasionally appear and block further input until handled:
//   - "Resume from summary? Press Enter to confirm"
//   - "0: Dismiss" feedback survey
//
// Data-driven: each entry describes a text match and the keys to send.
// Keep this list as data so adding a new dialog is a one-line change.

// Regression note (1.16.2): the matchers MUST only fire when the dialog is
// currently visible at the BOTTOM of the pane — not anywhere in scrollback.
// Earlier code did `text.includes("0: Dismiss")` which kept matching after
// the survey had already been dismissed (the string lingered in capture-pane
// -S -20 scrollback). Each false positive sent `'0' Enter` to dismiss a
// menu that wasn't there, so the "0" landed in the input box as literal
// text — users saw `❯ 0` repeated 3-4× per message because dismiss runs
// from multiple call sites and a 3-attempt retry loop in processMessage.
//
// `tailLines` returns the last N non-empty lines of captured pane text. We
// match against the very bottom of the screen — when a dialog is *active*,
// it's the last thing rendered. When it's been dismissed, the input prompt
// (`❯`, `›`, `>`) sits below the old dialog text, so a tight window rejects
// scrollback hits.
function tailLines(text, n) {
  return text.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n);
}

export const BLOCKING_PROMPTS = [
  {
    name: "resume",
    // The resume dialog renders as a single line that includes both phrases.
    // Require the LAST non-empty line to match — anything below it (typical:
    // an input prompt char) means the dialog is gone.
    match: (text) => {
      const lines = tailLines(text, 1);
      const last = lines[0] || "";
      return last.includes("Resume from summary") && last.includes("Enter to confirm");
    },
    keys: "Enter",
    waitMs: 3000,
  },
  {
    name: "dismiss",
    // Codex feedback survey layout (active state):
    //   <prev row>
    //   1: Bad  2: Fine  3: Good
    //   0: Dismiss          ← bottom line when active
    // Require "0: Dismiss" in the last 2 lines AND the rating row in the
    // last 4. Once the survey is dismissed, the input prompt line (`❯`) is
    // appended below — so the tight 2-line window rejects stale scrollback.
    match: (text) => {
      const last2 = tailLines(text, 2).join("\n");
      const last4 = tailLines(text, 4).join("\n");
      return last2.includes("0: Dismiss")
          && /1:\s*\S+\s+2:\s*\S+\s+3:\s*\S+/.test(last4);
    },
    keys: "'0' Enter",
    waitMs: 500,
  },
];

/**
 * Scan captured pane text for a blocking prompt and return the first match,
 * or null. Pure function, no side effects.
 */
export function findBlockingPrompt(paneText) {
  for (const prompt of BLOCKING_PROMPTS) {
    if (prompt.match(paneText)) return prompt;
  }
  return null;
}
