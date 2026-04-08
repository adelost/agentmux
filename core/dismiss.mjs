// Blocking prompt recognition and dismissal for Claude/Codex panes.
// These dialogs occasionally appear and block further input until handled:
//   - "Resume from summary? Press Enter to confirm"
//   - "0: Dismiss" feedback survey
//
// Data-driven: each entry describes a text match and the keys to send.
// Keep this list as data so adding a new dialog is a one-line change.

export const BLOCKING_PROMPTS = [
  {
    name: "resume",
    match: (text) => text.includes("Resume from summary") && text.includes("Enter to confirm"),
    keys: "Enter",
    waitMs: 3000,
  },
  {
    name: "dismiss",
    match: (text) => text.includes("0: Dismiss"),
    keys: "'0' Enter",
    waitMs: 500,
  },
];

/**
 * Scan captured pane text for a blocking prompt and return the first match,
 * or null. Pure function — no side effects.
 */
export function findBlockingPrompt(paneText) {
  for (const prompt of BLOCKING_PROMPTS) {
    if (prompt.match(paneText)) return prompt;
  }
  return null;
}
