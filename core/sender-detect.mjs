// Detect the orchestrator pane that originated an amux-CLI invocation.
// When an agent in tmux runs `amux <other> -p N "brief"`, the receiver
// should see who briefed them. This module does detection + formatting
// as pure functions so tests don't need a live tmux.

/**
 * Detect sender from tmux env. Returns "session:windowIndex" or null.
 *
 * execFn is injected so tests can mock. In production, pass a function
 * that runs `tmux display -p '<fmt>'` synchronously and returns stdout.
 */
export function detectSenderFromEnv(env, execFn) {
  if (!env.TMUX) return null;
  try {
    const session = execFn("tmux display -p '#S'").trim();
    const windowIdx = execFn("tmux display -p '#I'").trim();
    if (!session || !windowIdx) return null;
    return `${session}:${windowIdx}`;
  } catch {
    return null;
  }
}

/**
 * Prepend a "[from sender]" header to a brief. If sender is null (not in
 * tmux, or tmux unresponsive), returns the brief unchanged.
 *
 * Header uses blank-line separator so Claude's prompt-parser treats it
 * as preamble context rather than part of the instruction.
 */
export function prependSenderHeader(text, sender) {
  if (!sender) return text;
  return `[from ${sender}]\n\n${text}`;
}
