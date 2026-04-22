// Detect the orchestrator pane that originated an amux-CLI invocation.
// When an agent in tmux runs `amux <other> -p N "brief"`, the receiver
// should see who briefed them. This module does detection + formatting
// as pure functions so tests don't need a live tmux.

/**
 * Detect sender from tmux env. Returns "session:paneIndex" or null, where
 * paneIndex is normalized to 0-based agentmux addressing (tmux's window
 * index minus its base-index, since agentmux surfaces panes 0..N-1 in ps
 * while tmux defaults to base-index 1 on most configs).
 *
 * execFn is injected so tests can mock. In production, pass a function
 * that runs shell commands synchronously and returns stdout.
 */
export function detectSenderFromEnv(env, execFn) {
  if (!env.TMUX) return null;
  try {
    const session = execFn("tmux display -p '#S'").trim();
    const windowIdxRaw = execFn("tmux display -p '#I'").trim();
    if (!session || !windowIdxRaw) return null;
    const windowIdx = parseInt(windowIdxRaw, 10);
    if (!Number.isFinite(windowIdx)) return null;

    // base-index may be set globally or per-session; prefer server-global
    // since agentmux panes all share the same tmux server.
    let baseIdx = 0;
    try {
      const out = execFn("tmux show -g base-index").trim();
      const parts = out.split(/\s+/);
      const parsed = parseInt(parts[parts.length - 1], 10);
      if (Number.isFinite(parsed)) baseIdx = parsed;
    } catch {
      // base-index lookup optional; default 0 matches tmux factory default
    }

    return `${session}:${windowIdx - baseIdx}`;
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
