import { applyAskBindings, buildAskEntries } from "./ask-history.mjs";
import { inferAskOrigin } from "./ask-origin.mjs";
import { observedAskOrigin } from "./ask-source-evidence.mjs";
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
export function conversationAskEntries(log, { nowMs = Date.now(), waiting, bindings = [] } = {}) {
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
      const [entry] = buildAskEntries({ agent: ask.agent, pane: ask.pane, nowMs, waiting,
        turns: [{ ...turn, timestamp: ask.ts, userPrompt: ask.verbatim, isComplete: turn.items.length > 0 }] });
      entries.push({ ...entry, ledgerId: id, ledgerPath: ask.ledgerPath, source: ask.source,
        reply: turn.items.map(item => item.content).join("\n\n"),
        origin: observedAskOrigin(ask, inferAskOrigin), observationIds: ask.observationIds,
        originEvidence: ask.originEvidence, nativeEvent: ask.nativeEvent,
        sender: ask.sender, repo: ask.repo || ask.agent, replySource: "conversation-log",
        sessionFile: ask.sessionFile, deliveryPath: ask.deliveryPath, deliveryStatus: ask.deliveryStatus });
    }
  }
  return applyAskBindings(entries, bindings);
}

/** WHAT: Formats exact input and posted text under a visible output budget. WHY: Prevents large pasted context from flooding a normal log read. */
export function formatConversationGroups(groups, { maxBytes = 65536 } = {}) {
  const render = row => {
    const input = row.event === "ask";
    const label = input ? `IN ${observedAskOrigin(row, inferAskOrigin)}`
      : `OUT ${row.kind} ${row.status || "sent"}`;
    const header = `${label} ${row.ts} ${row.agent}:${row.pane} id=${row.id}`
      + (row.messageId ? ` Discord=${row.messageId}` : "");
    const body = input ? row.verbatim : [row.text, ...(row.files || []).map(file => `[file: ${file}]`), row.error].filter(Boolean).join("\n");
    return `${header}\n${body}`;
  };
  const text = groups.map(group => group.map(render).join("\n\n")).join("\n\n");
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = "[Display truncated: older content omitted; newest records follow. Narrow --since/--grep or raise --max-bytes for more.]\n";
  const bytes = Buffer.from(text), keep = Math.max(0, maxBytes - Buffer.byteLength(marker));
  return marker + bytes.subarray(bytes.length - keep).toString("utf8").replace(/^\uFFFD+/u, "");
}
