// Full autonomous execution for every agentmux launch path.
//
// Mattias explicitly authorizes unattended workers to run without approval
// prompts. Keep that standing authority centralized here so tmux, one-shot
// commands and the native web runtime cannot drift into different modes.

export const CLAUDE_AUTONOMOUS_ARGS = Object.freeze([
  "--dangerously-skip-permissions",
]);

export const CODEX_AUTONOMOUS_ARGS = Object.freeze([
  "--yolo",
]);

/** WHAT: Defines Kimi autonomous argv. WHY: Keeps Kimi launch surfaces from drifting. */
export const KIMI_AUTONOMOUS_ARGS = Object.freeze([
  "--auto",
]);

export const CODEX_APP_SERVER_ARGS = Object.freeze([
  "app-server",
  "--stdio",
]);

export const CODEX_AUTONOMOUS_THREAD_POLICY = Object.freeze({
  sandbox: "danger-full-access",
  approvalPolicy: "never",
});

export const CODEX_AUTONOMOUS_TURN_POLICY = Object.freeze({
  sandboxPolicy: Object.freeze({
    type: "dangerFullAccess",
  }),
  approvalPolicy: "never",
});

// This file used to contain GUI/browser deny rules. Reconcile it to a
// comment-only policy so existing Codex profiles lose those stale restrictions
// on their next launch without touching any user-owned rule files.
export const CODEX_EXTERNAL_NAVIGATION_RULES = `# Managed by agentmux.
# Full autonomous mode: no agentmux execpolicy restrictions.
`;

const SAFE_SHELL_ARG = /^[A-Za-z0-9_./:=+-]+$/;

/** Render fixed argv as a shell fragment without weakening its argument boundaries. */
export function renderShellArgs(args) {
  return args.map((arg) => {
    const value = String(arg);
    if (SAFE_SHELL_ARG.test(value)) return value;
    return `'${value.replaceAll("'", `'\\''`)}'`;
  }).join(" ");
}

/** WHAT: Formats Claude autonomous flags. WHY: Keeps shell boundaries centralized. */
export const CLAUDE_AUTONOMOUS_FLAGS = renderShellArgs(CLAUDE_AUTONOMOUS_ARGS);
/** WHAT: Formats Codex autonomous flags. WHY: Keeps shell boundaries centralized. */
export const CODEX_AUTONOMOUS_FLAGS = renderShellArgs(CODEX_AUTONOMOUS_ARGS);
/** WHAT: Formats Kimi autonomous flags. WHY: Keeps shell boundaries centralized. */
export const KIMI_AUTONOMOUS_FLAGS = renderShellArgs(KIMI_AUTONOMOUS_ARGS);
