// WHAT: Pure helpers for turning pane jsonl turns into a "what did I ask?"
//       ledger with open/done-ish status.
// WHY: Humans and orchestrator agents need a compact map from directive →
//      pane → jsonl location when work was handed out but not clearly closed.
// DOES NOT: Read files, inspect tmux, parse config, or decide pane ownership.

import { isAskToHuman, looksDone, previewText } from "./orchestrator-checkpoint.mjs";
import { isLiveStatus } from "./pane-status.mjs";
import { isSystemNoiseDirective } from "./system-noise.mjs";

const OPEN_STATUSES = new Set(["open", "working", "partial", "needs-you"]);
const LIVE_MATCH_WINDOW_MS = 15 * 60 * 1000;

export function classifyAskTurn(turn = {}, opts = {}) {
  const {
    isLatest = false,
    paneStatus = "unknown",
  } = opts;

  const items = Array.isArray(turn.items) ? turn.items : [];
  const reply = latestTextItem(items);
  const fullReply = allTextItems(items);
  const live = isLiveStatus(paneStatus);

  if (!reply) return isLatest && live ? "working" : "open";
  if (isLatest && live && !turn.isComplete) return "working";
  if (looksDoneForAsk(reply) || looksDoneForAsk(fullReply)) return "done";
  // Provenance-aware: a question answering an inter-agent envelope is that
  // agent's ball, not the human's — it classifies as answered instead.
  if (isAskToHuman(reply, turn.userPrompt)) return "needs-you";
  if (!turn.isComplete) return "partial";
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
    // A /compact wrapper or continuation preamble is not an ask anyone made.
    if (!turn.userPrompt || isSystemNoiseDirective(turn.userPrompt)) continue;
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

export function askAnchorKey(timestamp, prompt) {
  return `${timestamp || ""}\u0000${prompt || ""}`;
}

export function attachAskLineAnchors(entries = [], lineByAnchor = new Map()) {
  return entries.map((entry) => ({
    ...entry,
    jsonlLine: lineByAnchor.get(askAnchorKey(entry.timestamp, entry.prompt)) || null,
  }));
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

/**
 * The durable ledger owns identity and retention; provider history only adds
 * an observed answer/status while its session still exists. Legacy live turns
 * remain visible until every producer has emitted durable rows at least once.
 */
export function joinAskLedgerEntries({
  ledgerEntries = [],
  liveEntries = [],
  nowMs = Date.now(),
  matchWindowMs = LIVE_MATCH_WINDOW_MS,
} = {}) {
  const byPrompt = new Map();
  for (const live of liveEntries) {
    const key = askPromptKey(live.agent, live.pane, live.prompt);
    if (!byPrompt.has(key)) byPrompt.set(key, []);
    byPrompt.get(key).push(live);
  }
  const claimed = new Set();
  const rows = [];

  for (const ledger of ledgerEntries) {
    if (!ledger?.verbatim || isSystemNoiseDirective(ledger.verbatim)) continue;
    const tsMs = parseTs(ledger.ts);
    const candidates = byPrompt.get(askPromptKey(ledger.agent, ledger.pane, ledger.verbatim)) || [];
    const live = candidates
      .filter((candidate) => !claimed.has(candidate)
        && ledgerMatchesLive(ledger, candidate, tsMs, matchWindowMs))
      .sort((left, right) => Math.abs(left.tsMs - tsMs) - Math.abs(right.tsMs - tsMs))[0];
    if (live) claimed.add(live);

    rows.push({
      ...(live || {}),
      agent: ledger.agent,
      pane: ledger.pane,
      key: `${ledger.agent}:${ledger.pane}`,
      timestamp: ledger.ts || live?.timestamp || null,
      tsMs,
      ageMs: Number.isFinite(tsMs) ? nowMs - tsMs : Infinity,
      prompt: ledger.verbatim,
      promptPreview: previewText(ledger.verbatim, 120),
      reply: live?.reply || "",
      replyPreview: live?.replyPreview || "",
      status: live?.status || "archived",
      open: live?.open || false,
      jsonlFile: live?.jsonlFile || null,
      sessionFile: ledger.sessionFile || live?.jsonlFile || null,
      sessionId: ledger.sessionId || null,
      source: ledger.source || "unknown",
      repo: ledger.repo || ledger.agent,
      ledgerPath: ledger.ledgerPath || null,
      ledgerId: ledger.id || null,
    });
  }

  for (const live of liveEntries) {
    if (!claimed.has(live)) rows.push({ ...live, repo: live.repo || live.agent, legacyLiveOnly: true });
  }
  return rows;
}

export function summarizeAskEntries(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const repo = entry.repo || entry.agent || "unknown";
    const group = groups.get(repo) || {
      repo, total: 0, open: 0, archived: 0, answered: 0, newestTsMs: 0,
    };
    group.total++;
    if (entry.open) group.open++;
    if (entry.status === "archived") group.archived++;
    else if (!entry.open) group.answered++;
    if (Number.isFinite(entry.tsMs)) group.newestTsMs = Math.max(group.newestTsMs, entry.tsMs);
    groups.set(repo, group);
  }
  return [...groups.values()].sort((left, right) =>
    right.open - left.open || right.newestTsMs - left.newestTsMs || left.repo.localeCompare(right.repo));
}

function askPromptKey(agent, pane, prompt) {
  return `${agent || ""}\u0000${Number(pane) || 0}\u0000${prompt || ""}`;
}

function ledgerMatchesLive(ledger, live, ledgerTsMs, matchWindowMs) {
  if (ledger.sessionFile && live.jsonlFile && ledger.sessionFile === live.jsonlFile) return true;
  if (!Number.isFinite(ledgerTsMs) || !Number.isFinite(live.tsMs)) return false;
  return Math.abs(ledgerTsMs - live.tsMs) <= matchWindowMs;
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

function allTextItems(items) {
  return items
    .filter((item) => item?.type !== "tool")
    .map((item) => String(item?.content || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

function looksDoneForAsk(text) {
  if (!text) return false;
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) return false;
  const head = collapsed.slice(0, 600).toLowerCase();
  if (/\b(inte|ej|not)\s+(klar|klart|klara|fixat|done|complete[d]?)/.test(head)) {
    return looksDone(collapsed);
  }
  return looksDone(collapsed)
    || looksDone(collapsed.slice(0, 240))
    || [/\bklar(t|a)?\b/, /\bfixat\b/, /\bpushad?\b|\bpushed\b/, /\bshipped\b/, /\bcomplete[d]?\b/]
      .some((r) => r.test(head));
}

function parseTs(ts) {
  if (!ts) return NaN;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : NaN;
}
