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
 * Pane lookup uses $TMUX_PANE (per-process, e.g. %18) targeted via
 * `tmux display -t <pane-id>`. Plain `tmux display -p '#P'` reports the
 * CURRENTLY-ACTIVE pane (whichever the user is viewing), not the calling
 * shell — that mismatch caused [from claw:3] to land in claw:3's channel
 * when claw:p1 briefed p3 while the user was viewing p3.
 *
 * execFn is injected so tests can mock. In production, pass a function
 * that runs shell commands synchronously and returns stdout.
 */
export function detectSenderFromEnv(env, execFn) {
  const nativeSession = String(env.AMUX_AGENT_NAME || "").trim();
  const nativePane = Number(env.AMUX_PANE);
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(nativeSession)
      && Number.isSafeInteger(nativePane) && nativePane >= 0) {
    return `${nativeSession}:${nativePane}`;
  }
  if (!env.TMUX) return null;
  // TMUX_PANE is the per-process pane id (%17, %18, ...) inherited from
  // the calling shell. It survives across active-pane switches, unlike
  // `tmux display`'s default which follows the user's view.
  const tmuxPane = env.TMUX_PANE;
  if (!tmuxPane) return null;
  try {
    const session = execFn(`tmux display -p -t '${tmuxPane}' '#S'`).trim();
    const paneIdxRaw = execFn(`tmux display -p -t '${tmuxPane}' '#P'`).trim();
    if (!session || paneIdxRaw === "") return null;
    const paneIdx = parseInt(paneIdxRaw, 10);
    if (!Number.isFinite(paneIdx)) return null;

    return `${session}:${paneIdx}`;
  } catch {
    return null;
  }
}

/**
 * WHAT: Returns structured provenance for the calling pane.
 * WHY: Keeps event hooks from reimplementing tmux's caller-vs-active-pane distinction.
 */
export function detectPaneAddress(env, execFn) {
  const sender = detectSenderFromEnv(env, execFn);
  return parseSenderAddress(sender);
}

/**
 * WHAT: Parses the exact address format emitted by sender detection.
 * WHY: Keeps double-digit panes and invalid identities out of ad-hoc string splitting.
 */
export function parseSenderAddress(sender) {
  const match = String(sender || "").match(/^([a-zA-Z0-9_-]{1,64}):(\d+)$/);
  if (!match) return null;
  const pane = Number(match[2]);
  if (!Number.isSafeInteger(pane)) return null;
  return { session: match[1], pane, key: `${match[1]}:${pane}` };
}

/**
 * WHAT: Checks a detected pane against the injected fleet policy.
 * WHY: Keeps stale surplus panes from acting as configured agents or dispatchers.
 */
export function assertConfiguredSender(sender, validate) {
  if (!sender) return null;
  const address = parseSenderAddress(sender);
  if (!address) throw new Error(`Invalid sender identity '${sender}'`);
  try {
    validate(address.session, address.pane);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Sender '${sender}' is outside the configured fleet: ${reason}`);
  }
  return address;
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
  const existing = parseSenderHeader(text);
  if (existing?.key === sender) return text;
  return `[from ${sender}]\n\n${text}`;
}

/** Recover structured provenance from a prompt previously wrapped above. */
export function parseSenderHeader(text) {
  const match = String(text || "").match(/^\[from ([a-zA-Z0-9_-]+):(\d+)\](?:\r?\n|$)/);
  if (!match) return null;
  return { session: match[1], pane: Number(match[2]), key: `${match[1]}:${Number(match[2])}` };
}
