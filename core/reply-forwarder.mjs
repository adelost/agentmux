// Shared reply-forwarder: bridge-initiated input to a pane (drift-guard
// reminders, amux send briefs, future hint/compact mirrors) gets a follow-up
// post to the bound Discord channel with whatever the agent emitted in
// response. Without this, every bridge-driven action is a one-way write
// from Discord's perspective — observers see the input, not the outcome.
//
// Usage pattern: call forwardReplyAsync after sending the prompt. It
// detaches, polls for idle, reads the matching turn from jsonl, filters
// boilerplate, posts. All errors are logged and swallowed (transparency
// degradation, not correctness).

import { readLastTurns } from "./jsonl-reader.mjs";

// Replies that don't carry signal worth mirroring. Match case-insensitively
// against trimmed reply text. If everything is boilerplate, skip — channel
// already has the input mirrored.
const BOILERPLATE_PATTERNS = [
  /^no response requested\.?$/i,
  /^acknowledged\.?$/i,
  /^re-?l(ä|a)st\.?$/i,
  /^l(ä|a)st\.?\s*standby\.?$/i,
  /^standby\.?$/i,
  /^(ok|okej|ok\.?|okay)\.?$/i,
];

export function isBoilerplateReply(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return true;
  return BOILERPLATE_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Pull the assistant's text response to the most recent matching user-turn
 * in paneDir's jsonl. matcher is a predicate over userPrompt strings; the
 * turn it picks is "our" turn, and we return that turn's joined text items.
 *
 * Returns null when no matching turn exists (jsonl write may lag, or the
 * matcher's prompt never landed) OR when the turn has no text items
 * (silent absorption). Caller distinguishes timeout vs no-reply by polling
 * idle first.
 */
export function extractMatchingReply(paneDir, sinceMs, matcher) {
  // Slack window — jsonl write may post-date sendOnly's wall-clock by a
  // few hundred ms.
  const since = new Date(sinceMs - 2000);
  const result = readLastTurns(paneDir, { since, limit: 5 });
  if (!result || !result.turns.length) return null;
  // Most recent matching turn first (reverse) — handles the case where
  // multiple briefs fired and we want the latest one's reply.
  const target = [...result.turns].reverse().find(
    (t) => t.userPrompt && matcher(t.userPrompt),
  );
  if (!target) return null;
  const textItems = target.items.filter((it) => it.type === "text");
  if (!textItems.length) return null;
  return textItems.map((it) => it.content).join("\n\n").trim();
}

/**
 * Generic detached reply-forwarder. Polls isBusy until idle (or timeout),
 * extracts the matching reply, filters boilerplate, posts to channel.
 *
 * @param {object} args
 * @param {object} args.agent           - injected agent instance with isBusy
 * @param {object} args.discord         - injected discord with send(channelId, text)
 * @param {string} args.agentName       - tmux session name (e.g., "claw")
 * @param {number} args.pane            - pane index
 * @param {string} args.channelId       - bound Discord channel
 * @param {string} args.paneDir         - pane's cwd (for jsonl lookup)
 * @param {number} args.sentAtMs        - epoch ms when prompt was injected
 * @param {function} args.matcher       - predicate(userPromptText) → boolean
 * @param {number} [args.timeoutMs=120000] - max wait for idle
 * @param {function} [args.log=console.log]
 * @param {string}  [args.label="reply-forward"] - prefix for log lines
 */
export function forwardReplyAsync({
  agent,
  discord,
  agentName,
  pane,
  channelId,
  paneDir,
  sentAtMs,
  matcher,
  timeoutMs = 120_000,
  log = (msg) => console.log(`reply-forward | ${msg}`),
  label = "reply-forward",
}) {
  if (!channelId || !discord) return;
  (async () => {
    const deadline = sentAtMs + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(2000);
      let busy = true;
      try { busy = await agent.isBusy(agentName, pane); }
      catch { /* treat as busy, retry */ }
      if (!busy) break;
    }
    const reply = extractMatchingReply(paneDir, sentAtMs, matcher);
    const tag = `${agentName}:${pane}`;
    if (!reply) {
      log(`${tag}: no reply (silent or timeout) [${label}]`);
      return;
    }
    if (isBoilerplateReply(reply)) {
      log(`${tag}: boilerplate skipped [${label}] (${reply.slice(0, 40).replace(/\n/g, " ")})`);
      return;
    }
    const safe = reply.length > 1900 ? reply.slice(0, 1900) + "\n…[truncated]" : reply;
    try {
      await discord.send(channelId, safe);
      log(`${tag}: forwarded reply (${reply.length}b) [${label}]`);
    } catch (err) {
      log(`${tag}: forward send failed [${label}]: ${err.message}`);
    }
  })().catch((err) => log(`${agentName}:${pane}: forwarder crashed [${label}]: ${err.message}`));
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
