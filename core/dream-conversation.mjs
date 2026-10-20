// Dream's conversation-log source: asks in, posts out, one format for every
// engine (docs/CONVERSATION-LOG.md). It works on rows from readWindow in
// core/ask-ledger.mjs, the only module that parses the file. The journal stays
// an explicit source retreat and a fallback for incomplete pre-log windows
// or panes without posted work.

import { DREAM_SETTLE_MS } from "./dream-turn-selection.mjs";
import { humanAsksOf, inferAskOrigin } from "./ask-origin.mjs";
import { isSystemNoiseDirective } from "./system-noise.mjs";

/** WHAT: Names the post kinds that carry a pane's own output. WHY: Mirrors and notices repeat an ask or report status; they are not the answer. */
export const DREAM_ANSWER_KINDS = new Set(["reply", "file", "voice"]);

const tsMs = (row) => Date.parse(row?.ts || "");
const paneKey = (row) => `${row.agent}:${row.pane}`;
const byTime = (left, right) => tsMs(left) - tsMs(right);
const originOf = ask => inferAskOrigin({ source: ask.source, sender: ask.sender, prompt: ask.verbatim });

const postedText = (post) => [post.text, ...(post.files || []).map((file) => `[file: ${file}]`)]
  .filter(Boolean).join("\n");

/**
 * WHAT: Maps consecutive inputs and posted output to logical turns with every ask id.
 * WHY: Keeps shared responses from hiding inputs or closing another author's unanswered request.
 */
export function conversationPaneTurns(asks, posts) {
  const ordered = asks.filter(ask => !isSystemNoiseDirective(ask.verbatim)).sort(byTime);
  const replies = posts.filter(post => post.status !== "failed" && DREAM_ANSWER_KINDS.has(post.kind)).sort(byTime);
  const turns = [];
  for (let index = 0; index < ordered.length;) {
    const ask = ordered[index], first = index, origin = originOf(ask);
    const startMs = tsMs(ask);
    const firstReplyMs = tsMs(replies.find(post => tsMs(post) >= startMs)) || Infinity;
    while (index + 1 < ordered.length && tsMs(ordered[index + 1]) <= firstReplyMs
      && originOf(ordered[index + 1]) === origin
      && ask.source !== "dream" && ordered[index + 1].source !== "dream") index++;
    const endMs = index + 1 < ordered.length ? tsMs(ordered[index + 1]) : Infinity;
    const inputs = ordered.slice(first, index + 1);
    const answers = replies.filter(post => tsMs(post) >= startMs && tsMs(post) < endMs);
    turns.push({
      timestamp: inputs.at(-1).ts,
      userPrompt: inputs.map(input => input.verbatim).join("\n\n"),
      isComplete: index + 1 < ordered.length,
      items: answers.map((post) => ({ type: "text", content: postedText(post) })),
      logId: inputs.at(-1).id,
      logIds: inputs.map(input => input.id),
    });
    index++;
  }
  return turns;
}

/**
 * WHAT: Returns one pane's asks and posts in a window, without Dream's own run.
 * WHY: Keeps Dream from summarizing its curator prompt and the curator's reply to it.
 */
export function conversationForPane(log, agent, pane, windowStartMs) {
  const key = `${agent}:${pane}`;
  const asks = log.asks.filter((ask) => paneKey(ask) === key && tsMs(ask) > windowStartMs);
  const dreamRuns = asks.filter((ask) => ask.source === "dream").map(tsMs);
  const posts = log.posts.filter((post) => paneKey(post) === key && tsMs(post) > windowStartMs);
  const turns = conversationPaneTurns(asks, posts).filter((turn) => !dreamRuns.includes(Date.parse(turn.timestamp)));
  const firstInput = Math.min(Infinity, ...asks.map(tsMs));
  const prior = log.asks.filter(ask => paneKey(ask) === key && tsMs(ask) <= windowStartMs
    && !isSystemNoiseDirective(ask.verbatim)).sort(byTime).at(-1);
  const continued = posts.filter(post => tsMs(post) < firstInput && post.status !== "failed" && DREAM_ANSWER_KINDS.has(post.kind)).sort(byTime);
  if (continued.length && prior?.source !== "dream") {
    // This is posted work, not a newly authored input. Its real post time
    // advances the cursor; the older prompt is quoted only as context.
    turns.unshift({ timestamp: continued.at(-1).ts, isComplete: false, logIds: [],
      userPrompt: `[amux posted continuation; original input ${prior ? `at ${prior.ts}, quoted for context` : "outside this log window"}]`
        + (prior ? `\n${prior.verbatim}` : ""),
      items: continued.map(post => ({ type: "text", content: postedText(post) })),
    });
  }
  const answered = posts.some((post) => post.status !== "failed" && DREAM_ANSWER_KINDS.has(post.kind));
  const lastWriteMs = Math.max(-Infinity, ...asks.map(tsMs), ...posts.map(tsMs));
  return { turns, answered, lastWriteMs };
}

/**
 * The asks are counted through humanAsksOf: amux's own notices and a prompt typed three or more times are not human asks.
 * WHAT: Returns how many settled human-facing asks got an answer posted on their pane.
 * WHY: Keeps unanswered requests visible as health without treating that share as cutover authority.
 */
export function answeredShare(log, { sinceMs = log.coverageStartMs, nowMs = Date.now() } = {}) {
  const humanAsks = new Set(humanAsksOf(log.asks));
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
    const byId = new Map(asks.map(ask => [ask.id, ask]));
    for (const turn of conversationPaneTurns(asks, posts)) for (const id of turn.logIds) {
      const ask = byId.get(id);
      const atMs = tsMs(ask);
      if (!humanAsks.has(ask) || atMs < sinceMs || nowMs - atMs < DREAM_SETTLE_MS) continue;
      asked++;
      if (turn.items.length) answered++;
      else unanswered[key] = (unanswered[key] || 0) + 1;
    }
  }
  return { asked, answered, share: asked ? answered / asked : null, unanswered };
}
