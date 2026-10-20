import { readWindow } from "./ask-ledger.mjs";
import { searchTokens, tokenMatches, scoreHit } from "./search.mjs";
import { formatConversationGroups } from "./conversation-view.mjs";
import { isSystemNoiseDirective } from "./system-noise.mjs";

const textOf = row => row.event === "ask" ? row.verbatim : row.text;

/** WHAT: Names how far back the conversation log is searched. WHY: Keeps the scan and the daemon's window on one 30-day edge. */
export const CONVERSATION_WINDOW_MS = 30 * 86400000;
/** WHAT: Names the source weight of a conversation row. WHY: Keeps the scan and the daemon's window scoring rows alike. */
export const CONVERSATION_WEIGHT = 2;

/** WHAT: Returns the hit for one canonical row that holds every query word, else null. WHY: Keeps the scan and the daemon's window on one definition of a conversation hit. */
export function conversationHit(row, { words, query, nowMs }) {
  const text = textOf(row) || "";
  if (row.event === "ask" && isSystemNoiseDirective(text)) return null;
  const tokens = searchTokens(text);
  if (!words.every(word => tokens.some(candidate => tokenMatches(word, candidate)))) return null;
  const lowered = text.toLocaleLowerCase("sv-SE");
  const exact = lowered.includes(query.toLocaleLowerCase("sv-SE"));
  const offset = Math.max(0, lowered.indexOf(words[0]) - 60);
  const hit = { path: row.ledgerPath, line: 0, root: "conversation", weight: CONVERSATION_WEIGHT, layer: exact ? "L1" : "L2",
    date: row.ts?.slice(0, 10), timestamp: row.ts, conversationId: row.id,
    messageId: row.messageId, agent: row.agent, pane: row.pane, eventKind: row.event,
    dedupeKey: `conversation:${row.id}`, matches: words.length,
    snippet: text.slice(offset, offset + 220).replace(/\s+/gu, " ") };
  hit.score = scoreHit(hit, nowMs);
  return hit;
}

/** WHAT: Returns the best `max` hits, newest first among equal scores. WHY: Keeps the scan and the daemon's window ranking alike. */
export function rankConversationHits(hits, max) {
  return hits.sort((a, b) => b.score - a.score || Date.parse(b.timestamp) - Date.parse(a.timestamp)).slice(0, max);
}

/** WHAT: Returns matching canonical conversation rows without an index. WHY: Keeps posted words searchable after provider sessions disappear. */
export function searchConversationLog(query, { max = 12, nowMs = Date.now(), read = readWindow } = {}) {
  const words = [...new Set(searchTokens(query))];
  if (!words.length) return [];
  const log = read({ since: nowMs - CONVERSATION_WINDOW_MS });
  const hits = [];
  for (const row of [...log.asks, ...log.posts]) {
    const hit = conversationHit(row, { words, query, nowMs });
    if (hit) hits.push(hit);
  }
  return rankConversationHits(hits, max);
}

/** WHAT: Reads the exact saved row by immutable identity and event time. WHY: Keeps drill-down valid after rotation without dumping raw JSON or trusting a stale snippet. */
export function expandConversationHit(hit, { read = readWindow } = {}) {
  const time = Date.parse(hit.timestamp);
  if (!hit.conversationId || !Number.isFinite(time)) return "Invalid conversation reference; repeat the search.";
  const log = read({ since: time - 1, until: time + 1, agents: hit.agent ? [hit.agent] : null });
  const row = [...log.asks, ...log.posts].find(row => row.id === hit.conversationId);
  if (!row) return "Conversation row unavailable; repeat the search. No provider fallback was used.";
  return formatConversationGroups([[row]], { maxBytes: 32768 });
}
