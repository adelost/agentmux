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

// Claude Code's current workspace trust menu. It preselects "No, exit", so a
// bare Enter closes the pane instead of starting it. Match only while the menu
// is the last thing on screen, and return which option the cursor is on.
function activeWorkspaceTrustCursor(text) {
  const lines = tailLines(text, 14);
  if (!/^Enter to confirm\s*·\s*Esc to cancel$/u.test(lines.at(-1)?.trim() || "")) return null;
  const block = lines.join("\n");
  if (!/Is this a project you created or one you trust\?/u.test(block)) return null;
  const options = lines.map((line) => line.trim()).filter((line) => /(?:^|❯\s*)(?:No, exit|Yes, I trust this folder)$/u.test(line));
  const exit = options.findIndex((line) => line.endsWith("No, exit"));
  const trust = options.findIndex((line) => line.endsWith("Yes, I trust this folder"));
  if (options.length !== 2 || exit < 0 || trust < 0) return null;
  const cursor = options.findIndex((line) => line.startsWith("❯"));
  if (cursor === trust) return "trust";
  return cursor === exit && trust === exit + 1 ? "exit-above-trust" : null;
}

/** WHAT: Identifies the selected option in a live two-choice Codex startup menu. WHY: Never confirms a stale menu in scrollback. */
function activeCodexChoice(text, { header, first, second, footer }) {
  const lines = tailLines(text, 10);
  if (!footer.test(lines.at(-1)?.trim() || "")) return null;
  if (!lines.some(line => header.test(line))
      || !lines.some(line => first.test(line))
      || !lines.some(line => second.test(line))) return null;
  const selected = lines.find(line => /^\s*[›❯]\s*[12]\.\s/u.test(line)) || "";
  if (first.test(selected)) return "first";
  if (second.test(selected)) return "second";
  return null;
}

const UPDATE_MENU = {
  header: /Update available!/u,
  first: /^\s*[›❯]?\s*1\.\s*Update now\b/u,
  second: /^\s*[›❯]?\s*2\.\s*Skip\s*$/u,
  footer: /^Press enter to continue$/iu,
};
const PAUSED_GOAL_MENU = {
  header: /Resume paused goal\?/u,
  first: /^\s*[›❯]?\s*1\.\s*Resume goal\b/u,
  second: /^\s*[›❯]?\s*2\.\s*Leave paused\b/u,
  footer: /^Press enter to confirm or esc to go back$/iu,
};

/** WHAT: Maps active TUI menus to safe choices. WHY: Keeps startup from updating Codex or resuming unrelated work. */
export const BLOCKING_PROMPTS = [
  {
    name: "codex-update",
    match: text => activeCodexChoice(text, UPDATE_MENU) === "first",
    keys: "Down Enter",
    waitMs: 1000,
  },
  {
    name: "codex-update",
    match: text => activeCodexChoice(text, UPDATE_MENU) === "second",
    keys: "Enter",
    waitMs: 1000,
  },
  {
    name: "codex-paused-goal",
    match: text => activeCodexChoice(text, PAUSED_GOAL_MENU) === "first",
    keys: "Down Enter",
    waitMs: 1000,
  },
  {
    name: "codex-paused-goal",
    match: text => activeCodexChoice(text, PAUSED_GOAL_MENU) === "second",
    keys: "Enter",
    waitMs: 1000,
  },
  {
    name: "trust-directory",
    // A configured coding pane always runs inside agentmux's own .agents/N
    // directory and Codex starts with sandbox/approval bypass already explicit.
    // The first option is preselected, so one Enter accepts this one-time gate.
    // Keep the bottom-line requirement: stale trust text followed by a shell or
    // composer must never receive an unsolicited Enter.
    match: (text) => {
      const last = tailLines(text, 1)[0] || "";
      const last8 = tailLines(text, 8).join("\n");
      return /press enter to continue/i.test(last)
          && /do you trust the contents of this directory/i.test(last8)
          && /1\.\s*yes,\s*continue/i.test(last8);
    },
    keys: "Enter",
    waitMs: 2000,
  },
  {
    name: "workspace-trust",
    // A configured pane always starts in agentmux's own .agents/N directory, so
    // trusting that folder is the launch the operator already chose.
    match: (text) => activeWorkspaceTrustCursor(text) === "exit-above-trust",
    keys: "Down Enter",
    waitMs: 2000,
  },
  {
    name: "workspace-trust",
    match: (text) => activeWorkspaceTrustCursor(text) === "trust",
    keys: "Enter",
    waitMs: 2000,
  },
  {
    name: "resume",
    // Claude 2.1.212 changed this from one confirmation line to a three-choice
    // menu whose first, preselected option is "Resume from summary". Accept
    // only either exact active layout at the bottom of the pane. In
    // particular, prose or stale scrollback mentioning the option must never
    // receive an unsolicited Enter.
    match: (text) => {
      const lines = tailLines(text, 8);
      const last = lines.at(-1)?.trim() || "";
      if (last.includes("Resume from summary") && last.includes("Enter to confirm")) return true;
      const block = lines.join("\n");
      const fullMenu = /^Enter to confirm\s*·\s*Esc to cancel$/u.test(last)
          && /(?:❯\s*)?1\.\s*Resume from summary(?:\s*\(recommended\))?/u.test(block)
          && /2\.\s*Resume full session as-is/u.test(block)
          && /3\.\s*Don't ask me again/u.test(block);
      const heightClippedMenu = /^❯\s*1\.\s*Resume from summary\s*\(recommended\)$/u.test(last)
          && /This session is .+ tokens\./u.test(block)
          && /Resuming the full session will consume a substantial portion of your usage limits\./u.test(block)
          && /We recommend resuming from a summary\./u.test(block);
      return fullMenu || heightClippedMenu;
    },
    keys: "Enter",
    waitMs: 3000,
  },
  {
    name: "additional-safety-check",
    // Codex can pause a long-running turn while the provider performs an
    // additional safety review. Choosing "Keep waiting" preserves the same
    // model and review; it does not relax or bypass the safety decision.
    match: (text) => {
      const lines = tailLines(text, 10);
      const last = lines.at(-1)?.trim() || "";
      const block = lines.join("\n");
      return /^Press enter to confirm or esc to go back$/iu.test(last)
        && /Additional safety checks/iu.test(block)
        && /1\.\s*Retry with a faster model/iu.test(block)
        && /2\.\s*Keep waiting/iu.test(block)
        && /3\.\s*Learn more/iu.test(block);
    },
    // Option 1 is preselected in the observed menu.
    keys: "Down Enter",
    waitMs: 1000,
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

/** WHAT: Checks for an empty Claude composer. WHY: Keeps stale JSONL idle state from faking readiness. */
export function hasEmptyClaudeComposer(paneText) {
  return String(paneText || "").split("\n")
    .some((line) => /^\s*❯\s*$/u.test(line));
}
