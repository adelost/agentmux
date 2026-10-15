import { buildAskEntries } from "./ask-history.mjs";
import { inferAskOrigin } from "./ask-origin.mjs";
import { conversationPaneTurns } from "./dream-conversation.mjs";
import { isSystemNoiseDirective } from "./system-noise.mjs";

const at = row => Date.parse(row.ts);
const keyOf = row => `${row.agent}:${row.pane}`;

/** WHAT: Builds chronological groups of canonical inputs and posted outcomes. WHY: Keeps files, failed sends and orphan output visible without provider history. */
export function conversationGroups(log, agent, pane) {
  const rows = [...log.asks, ...log.posts].filter(row => row.agent === agent && row.pane === pane)
    .sort((a, b) => at(a) - at(b) || String(a.id).localeCompare(String(b.id)));
  const groups = [];
  for (const row of rows) {
    if (row.event === "ask" || !groups.length) groups.push([]);
    groups.at(-1).push(row);
  }
  return groups;
}

/** WHAT: Builds ask status from the complete posted answers. WHY: Keeps an engine restart or a legacy preview from changing conversation evidence. */
export function conversationAskEntries(log, { nowMs = Date.now() } = {}) {
  const byPane = new Map();
  for (const ask of log.asks) {
    if (isSystemNoiseDirective(ask.verbatim)) continue;
    const group = byPane.get(keyOf(ask)) || [];
    group.push(ask); byPane.set(keyOf(ask), group);
  }
  const entries = [];
  for (const [key, asks] of byPane) {
    const posts = log.posts.filter(post => keyOf(post) === key);
    const turns = conversationPaneTurns(asks, posts);
    const byId = new Map(asks.map(ask => [ask.id, ask]));
    for (const turn of turns) for (const id of turn.logIds) {
      const ask = byId.get(id);
      const [entry] = buildAskEntries({ agent: ask.agent, pane: ask.pane, nowMs,
        turns: [{ ...turn, timestamp: ask.ts, userPrompt: ask.verbatim, isComplete: turn.items.length > 0 }] });
      entries.push({ ...entry, ledgerId: id, ledgerPath: ask.ledgerPath, source: ask.source,
        reply: turn.items.map(item => item.content).join("\n\n"),
        origin: inferAskOrigin({ source: ask.source, sender: ask.sender, prompt: ask.verbatim }),
        sender: ask.sender, repo: ask.repo || ask.agent, replySource: "conversation-log",
        sessionFile: ask.sessionFile, deliveryPath: ask.deliveryPath, deliveryStatus: ask.deliveryStatus });
    }
  }
  return entries;
}

/** WHAT: Formats exact input and posted text under a visible output budget. WHY: Prevents large pasted context from flooding a normal log read. */
export function formatConversationGroups(groups, { maxBytes = 65536 } = {}) {
  const render = row => {
    const input = row.event === "ask";
    const label = input ? `IN ${inferAskOrigin({ source: row.source, sender: row.sender, prompt: row.verbatim })}`
      : `OUT ${row.kind} ${row.status || "sent"}`;
    const header = `${label} ${row.ts} ${row.agent}:${row.pane} id=${row.id}`
      + (row.messageId ? ` Discord=${row.messageId}` : "");
    const body = input ? row.verbatim : [row.text, ...(row.files || []).map(file => `[file: ${file}]`), row.error].filter(Boolean).join("\n");
    return `${header}\n${body}`;
  };
  const text = groups.map(group => group.map(render).join("\n\n")).join("\n\n");
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = "\n[Display truncated. Narrow --since/--grep or raise --max-bytes; exact rows remain in the conversation log.]";
  return Buffer.from(text).subarray(0, maxBytes - Buffer.byteLength(marker)).toString("utf8").replace(/\uFFFD$/u, "") + marker;
}
