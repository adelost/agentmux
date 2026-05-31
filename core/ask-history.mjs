// WHAT: Pure helpers for turning pane jsonl turns into a "what did I ask?"
//       ledger with open/done-ish status.
// WHY: Humans and orchestrator agents need a compact map from directive →
//      pane → jsonl location when work was handed out but not clearly closed.
// DOES NOT: Read files, inspect tmux, parse config, or decide pane ownership.

import { isWaitingLikeText, looksDone, previewText } from "./orchestrator-checkpoint.mjs";

const OPEN_STATUSES = new Set(["open", "working", "partial", "needs-you"]);

export function classifyAskTurn(turn = {}, opts = {}) {
  const {
    isLatest = false,
    paneStatus = "unknown",
  } = opts;

  const items = Array.isArray(turn.items) ? turn.items : [];
  const reply = latestTextItem(items);
  const live = paneStatus === "working" || paneStatus === "resume";

  if (!reply) return isLatest && live ? "working" : "open";
  if (isLatest && live && !turn.isComplete) return "working";
  if (isWaitingLikeText(reply)) return "needs-you";
  if (!turn.isComplete) return "partial";
  if (looksDone(reply)) return "done";
  return "answered";
}

export function askStatusIsOpen(status) {
  return OPEN_STATUSES.has(status);
}

export function buildAskEntries({
  agent,
  pane,
  turns = [],
  jsonlFile = null,
  paneStatus = "unknown",
  nowMs = Date.now(),
} = {}) {
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i] || {};
    if (!turn.userPrompt) continue;
    const tsMs = parseTs(turn.timestamp);
    const reply = latestTextItem(turn.items || []);
    const status = classifyAskTurn(turn, {
      isLatest: i === turns.length - 1,
      paneStatus,
    });
    out.push({
      agent,
      pane,
      key: `${agent}:${pane}`,
      timestamp: turn.timestamp || null,
      tsMs,
      ageMs: Number.isFinite(tsMs) ? nowMs - tsMs : Infinity,
      prompt: turn.userPrompt,
      promptPreview: previewText(turn.userPrompt, 120),
      reply,
      replyPreview: previewText(reply, 100),
      status,
      open: askStatusIsOpen(status),
      jsonlFile,
    });
  }
  return out;
}

export function filterAskEntries(entries = [], opts = {}) {
  const {
    sinceMs = null,
    grep = null,
    openOnly = false,
    limit = null,
  } = opts;

  let out = entries;
  if (Number.isFinite(sinceMs)) {
    out = out.filter((e) => Number.isFinite(e.tsMs) && e.tsMs >= sinceMs);
  }
  if (grep instanceof RegExp) {
    out = out.filter((e) => grep.test(e.prompt) || grep.test(e.reply || ""));
  }
  if (openOnly) out = out.filter((e) => e.open);

  out = [...out].sort((a, b) => (b.tsMs || 0) - (a.tsMs || 0));
  if (Number.isFinite(limit) && limit > 0 && out.length > limit) {
    out = out.slice(0, limit);
  }
  return out;
}

function latestTextItem(items) {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.type === "tool") continue;
    const text = String(item?.content || "").trim();
    if (text) return text;
  }
  return "";
}

function parseTs(ts) {
  if (!ts) return NaN;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : NaN;
}
