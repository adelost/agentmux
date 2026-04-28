// Helpers for the CLI `ax send` worker (cli/reply-forwarder-worker.mjs).
// Bridge-side reply forwarding moved to channels/jsonl-watcher.mjs in
// 1.16.31-1.16.33; the bespoke forwardReplyAsync that lived here was
// removed in 1.16.37 cleanup. Only the bits the CLI worker still needs
// remain: extractMatchingReply + isBoilerplateReply.

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

