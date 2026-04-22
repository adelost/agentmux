// Detect the orchestrator pane that originated an amux-CLI invocation.
// When an agent in tmux runs `amux <other> -p N "brief"`, the receiver
// should see who briefed them. This module does detection + formatting
// as pure functions so tests don't need a live tmux.

/**
 * Detect sender from tmux env. Returns "session:paneIndex" or null, matching
 * agentmux's addressing in `amux ps` (p0..pN). Agentmux lays each agent out
 * as a single tmux window with N panes, so we read the pane index via `#P`
 * (aka pane_index), not `#I` (window index which is always 1 in this model).
 *
 * Pane indices are 0-based by default in tmux and agentmux alike — no
 * base-index adjustment needed for panes. (Window base-index matters for
 * multi-window setups, but agentmux doesn't use those.)
 *
 * execFn is injected so tests can mock. In production, pass a function
 * that runs shell commands synchronously and returns stdout.
 */
export function detectSenderFromEnv(env, execFn) {
  if (!env.TMUX) return null;
  try {
    const session = execFn("tmux display -p '#S'").trim();
    const paneIdxRaw = execFn("tmux display -p '#P'").trim();
    if (!session || paneIdxRaw === "") return null;
    const paneIdx = parseInt(paneIdxRaw, 10);
    if (!Number.isFinite(paneIdx)) return null;

    return `${session}:${paneIdx}`;
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
