// Dream's conversation-log source: asks in, posts out, one format for every
// engine (docs/CONVERSATION-LOG.md). It works on rows from readWindow in
// core/ask-ledger.mjs, the only module that parses the file. Until the switch
// it only runs as a shadow; the journal stays the fallback for a pane that
// posted nothing in its window.

import { DREAM_SETTLE_MS } from "./dream-turn-selection.mjs";

/** WHAT: Names the post kinds that carry a pane's own output. WHY: Mirrors and notices repeat an ask or report status; they are not the answer. */
export const DREAM_ANSWER_KINDS = new Set(["reply", "file", "voice"]);
/** WHAT: Names the ask sources a person answers through. WHY: The shadow's coverage share is measured on human-facing asks. */
const HUMAN_ASK_SOURCES = new Set(["discord", "pane-hook"]);

const tsMs = (row) => Date.parse(row?.ts || "");
const paneKey = (row) => `${row.agent}:${row.pane}`;
const byTime = (left, right) => tsMs(left) - tsMs(right);

const postedText = (post) => [post.text, ...(post.files || []).map((file) => `[file: ${file}]`)]
  .filter(Boolean).join("\n");

/**
 * WHAT: Builds one pane's turns from its asks and the answers posted before the next ask.
 * WHY: Gives Dream the same turn shape as a journal without any engine-specific reader.
 */
export function conversationPaneTurns(asks, posts) {
  const ordered = [...asks].sort(byTime);
  return ordered.map((ask, index) => {
    const startMs = tsMs(ask);
    const endMs = index + 1 < ordered.length ? tsMs(ordered[index + 1]) : Infinity;
    const answers = posts.filter((post) => DREAM_ANSWER_KINDS.has(post.kind) && tsMs(post) >= startMs && tsMs(post) < endMs);
    return {
      timestamp: ask.ts,
      userPrompt: ask.verbatim,
      isComplete: index + 1 < ordered.length,
      items: answers.map((post) => ({ type: "text", content: postedText(post) })),
      logId: ask.id,
    };
  });
}

/**
 * WHAT: Selects one pane's asks and posts in a window, without Dream's own run.
 * WHY: Keeps Dream from summarizing its curator prompt and the curator's reply to it.
 */
export function conversationForPane(log, agent, pane, windowStartMs) {
  const key = `${agent}:${pane}`;
  const asks = log.asks.filter((ask) => paneKey(ask) === key && tsMs(ask) > windowStartMs);
  const dreamRuns = asks.filter((ask) => ask.source === "dream").map(tsMs);
  const posts = log.posts.filter((post) => paneKey(post) === key && tsMs(post) > windowStartMs);
  const turns = conversationPaneTurns(asks, posts).filter((turn) => !dreamRuns.includes(Date.parse(turn.timestamp)));
  const answered = posts.some((post) => DREAM_ANSWER_KINDS.has(post.kind));
  const lastWriteMs = Math.max(-Infinity, ...asks.map(tsMs), ...posts.map(tsMs));
  return { turns, answered, lastWriteMs };
}

/**
 * WHAT: Measures how many settled human-facing asks got an answer posted on their pane.
 * WHY: The switch waits until the log answers at least 95 % of them.
 */
export function answeredShare(log, { sinceMs = log.coverageStartMs, nowMs = Date.now() } = {}) {
  const byPane = new Map();
  for (const ask of log.asks) {
    if (!byPane.has(paneKey(ask))) byPane.set(paneKey(ask), []);
    byPane.get(paneKey(ask)).push(ask);
  }
  let asked = 0;
  let answered = 0;
  const unanswered = {};
  for (const [key, asks] of byPane) {
    // A failed send never reached the person, so it answers nothing.
    const posts = log.posts.filter((post) => paneKey(post) === key && post.status !== "failed");
    for (const turn of conversationPaneTurns(asks, posts)) {
      const ask = asks.find((row) => row.id === turn.logId);
      const atMs = tsMs(ask);
      if (!HUMAN_ASK_SOURCES.has(ask.source) || atMs < sinceMs || nowMs - atMs < DREAM_SETTLE_MS) continue;
      asked++;
      if (turn.items.length) answered++;
      else unanswered[key] = (unanswered[key] || 0) + 1;
    }
  }
  return { asked, answered, share: asked ? answered / asked : null, unanswered };
}
