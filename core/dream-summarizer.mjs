// Bounded journal input for the operator-selected nightly Dream pane.

import { panePathFor } from "./jsonl-reader.mjs";
import { readDreamPaneHistory } from "./dream-history.mjs";
import { conversationForPane } from "./dream-conversation.mjs";
import { dreamWindowStartMs, keepDreamTurns, selectDreamTurns } from "./dream-turn-selection.mjs";

/** WHAT: Defines how many turns one pane may show. WHY: Keeps one busy pane from crowding the others out of a batch. */
export const DREAM_SOURCE_TURNS = 24;
/** WHAT: Defines one turn's byte share. WHY: Keeps a busy pane's outcomes readable instead of clipped to their first words. */
export const DREAM_TURN_BYTES = 640;
/** WHAT: Defines the per-pane byte floor. WHY: Keeps a quiet pane's few turns from being clipped harder than before. */
export const DREAM_SOURCE_BYTES = 5 * 1024;
/** WHAT: Defines the per-pane byte ceiling. WHY: Prevents one pane from consuming the fleet budget. */
export const DREAM_SOURCE_MAX_BYTES = 16 * 1024;
/** WHAT: Defines the complete prompt ceiling. WHY: Keeps nightly model cost bounded as the fleet grows. */
export const DREAM_PROMPT_BYTES = 96 * 1024;
/** WHAT: Defines the pane-count ceiling. WHY: Keeps pathological configurations from expanding one run forever. */
export const DREAM_MAX_PANES = 48;
/** WHAT: Defines the model-product byte ceiling. WHY: Prevents one summary from bloating daily memory. */
export const DREAM_SUMMARY_BYTES = 12 * 1024;
/** WHAT: Defines the model-product line ceiling. WHY: The night's summary becomes the covered day's diary, so it must be short enough to read in one go. */
export const DREAM_SUMMARY_LINES = 25;

/** WHAT: Resolves supported journal dialects. WHY: Keeps unsupported panes from entering Dream input. */
export function dreamPaneEngine(pane = {}) {
  if (["claude", "codex", "kimi", "qwen", "gemini"].includes(pane.engine)) return pane.engine;
  const match = String(pane.cmd || "").match(/(?:^|[\s/])(claude|codex|kimi(?:-code)?|qwen|gemini)(?:\s|$)/u);
  if (!match) return null;
  return match[1].startsWith("kimi") ? "kimi" : match[1];
}

/**
 * WHAT: Reads one pane's window from the conversation log when it posted an answer there.
 * WHY: Keeps the provider journal, with its engine formats and tool output, a fallback only.
 */
function conversationHistory(conversation, agent, pane, cutoffMs) {
  if (!conversation) return null;
  const { log } = conversation;
  const found = conversationForPane(log, agent, pane, cutoffMs);
  // An unanswered input still belongs in the digest; selecting the log never authorizes a raw-journal fallback.
  return { turns: found.turns, lastWriteMs: found.lastWriteMs, reachedSince: log.coverageStartMs <= cutoffMs, fromLog: true };
}

/** WHAT: Collects journal-backed work without touching runtimes. WHY: Prevents Dream from waking or interrupting panes. */
export function collectDreamSources(agents, sinceMs, options = {}) {
  const receipts = options.receipts || { panes: {} };
  const readHistory = options.readHistory || readDreamPaneHistory;
  const limit = options.limit || DREAM_SOURCE_TURNS;
  const nowMs = options.now || Date.now();
  const sources = [];
  const unreadable = [];
  const skipped = [];
  for (const agent of agents) {
    if (agent.backend === "native" && !options.conversation) {
      for (let pane = 0; pane < (agent.panes || []).length; pane++) {
        skipped.push({ agent: agent.name, pane, reason: "native-history-adapter-required" });
      }
      continue;
    }
    for (let pane = 0; pane < (agent.panes || []).length; pane++) {
      const engine = dreamPaneEngine(agent.panes[pane]);
      if (!engine) continue;
      const cutoffMs = dreamWindowStartMs(receipts.panes[`${agent.name}:${pane}`], sinceMs);
      let result = conversationHistory(options.conversation, agent.name, pane, cutoffMs);
      if (!result) {
        try {
          result = readHistory(engine, panePathFor(agent, pane), { since: new Date(cutoffMs) });
        } catch (error) {
          unreadable.push({ agent: agent.name, pane, engine, reason: error.message });
          continue;
        }
      }
      const { entries, omittedTurns, deferredTurns, activityCursor, waitingSince } = selectDreamTurns(result?.turns || [], {
        cursorMs: cutoffMs, limit, lastWriteMs: result?.lastWriteMs, nowMs,
      });
      if (!entries.length) {
        if (deferredTurns) skipped.push({ agent: agent.name, pane, engine, reason: "active-turn-deferred", deferredTurns });
        continue;
      }
      sources.push({
        agent: agent.name,
        pane,
        engine,
        source: result?.fromLog ? "conversation-log" : "journal",
        turns: entries.length,
        omittedTurns,
        deferredTurns,
        historyComplete: result?.reachedSince !== false,
        activityCursor,
        latestMs: Date.parse(activityCursor),
        // Work from before the window missed an earlier digest: the night failed
        // or the pane was left out of a full batch.
        carriedOver: Date.parse(waitingSince) < sinceMs,
        filesOmitted: result?.filesOmitted || 0,
        entries,
      });
    }
  }
  sources.sort((left, right) => Number(right.carriedOver) - Number(left.carriedOver)
    || right.latestMs - left.latestMs || left.agent.localeCompare(right.agent) || left.pane - right.pane);
  return { sources, unreadable, skipped };
}

function clipUtf8(value, maxBytes) {
  const text = String(value || "").replace(/\u0000/g, "").trim();
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let clipped = Buffer.from(text).subarray(0, Math.max(0, maxBytes - 3)).toString("utf8");
  while (Buffer.byteLength(clipped) > maxBytes - 3) clipped = clipped.slice(0, -1);
  return `${clipped}...`;
}

function assistantText(items, maxBytes) {
  const texts = items.filter((item) => item.type === "text")
    .map((item) => String(item.content || "").replace(/\u0000/g, "").trim()).filter(Boolean);
  const all = texts.join("\n");
  if (Buffer.byteLength(all) <= maxBytes) return all;
  // A long work turn can reverse an earlier finding. Budget the latest actual
  // assistant text first, never present the clipped commentary as its outcome.
  const marker = texts.length > 1
    ? "[Earlier assistant text omitted; latest text follows]\n"
    : "[Assistant text truncated]\n";
  return marker + clipUtf8(texts.at(-1), maxBytes - Buffer.byteLength(marker));
}

function sourcePayload(source, maxBytes) {
  const perTurn = Math.max(160, Math.floor((maxBytes - 512) / source.entries.length));
  const turns = source.entries.map((turn) => ({
    at: turn.timestamp,
    user: clipUtf8(turn.userPrompt, Math.floor(perTurn * 0.35)),
    assistant: assistantText(turn.items || [], Math.floor(perTurn * 0.55)),
  }));
  return {
    pane: `${source.agent}:${source.pane}`,
    engine: source.engine,
    filesOmitted: source.filesOmitted,
    ...(source.omittedTurns ? { omittedTurns: source.omittedTurns } : {}),
    ...(source.deferredTurns ? { deferredTurns: source.deferredTurns } : {}),
    ...(source.historyComplete === false ? { historyComplete: false } : {}),
    turns,
  };
}

/** WHAT: Calculates one pane's share of a batch. WHY: Keeps a busy pane readable without letting it take the fleet budget. */
export function dreamSourceBytes(source) {
  const wanted = source.entries.length * DREAM_TURN_BYTES;
  return Math.min(DREAM_SOURCE_MAX_BYTES, Math.max(DREAM_SOURCE_BYTES, wanted));
}

function packedPane(source, maxBytes) {
  const pane = sourcePayload(source, maxBytes);
  const raw = JSON.stringify(pane);
  if (Buffer.byteLength(raw) <= maxBytes) return { source, pane };
  return { source, pane: { ...pane, turns: [{ at: source.activityCursor, user: clipUtf8(raw, maxBytes - 200), assistant: "" }] } };
}

/** WHAT: Splits the prompt budget so small panes get all they need and busy panes share the rest. WHY: Keeps every active pane in the digest; 2026-10-11 dropped 3 of 13 whole. */
function fairShares(needs, budget) {
  const shares = [];
  let left = budget;
  needs.map((need, index) => ({ need, index })).sort((a, b) => a.need - b.need)
    .forEach(({ need, index }, position, order) => {
      shares[index] = Math.min(need, Math.floor(left / (order.length - position)));
      left -= shares[index];
    });
  return shares;
}

/** WHAT: Shows as many of a pane's most important turns as fit its share, each at least a readable turn share. WHY: Keeps outcomes readable instead of clipping every turn to its first words. */
function fittedPane(source, maxBytes) {
  const keepTurns = (keep) => {
    const entries = keepDreamTurns(source.entries, keep);
    return { ...source, entries, turns: entries.length,
      omittedTurns: (source.omittedTurns || 0) + source.entries.length - entries.length };
  };
  for (let keep = source.entries.length; keep > 1; keep--) {
    const fitted = keepTurns(keep);
    const pane = sourcePayload(fitted, Math.max(maxBytes, 512 + keep * DREAM_TURN_BYTES));
    if (Buffer.byteLength(JSON.stringify(pane)) <= maxBytes) return { source: fitted, pane };
  }
  return packedPane(keepTurns(1), maxBytes);
}

/** WHAT: Builds a batch within fixed source budgets. WHY: Prevents fleet growth from flooding the curator pane. */
export function buildDreamBatch(sources, dateKey, options = {}) {
  const maxPanes = options.maxPanes || DREAM_MAX_PANES;
  const maxPromptBytes = options.maxPromptBytes || DREAM_PROMPT_BYTES;
  const candidates = sources.slice(0, maxPanes);
  const omitted = sources.slice(maxPanes).map((source) => ({ ...source, omitReason: "pane-limit" }));
  const wanted = candidates.map((source) => packedPane(source, options.maxSourceBytes || dreamSourceBytes(source)));
  const needs = wanted.map(({ pane }) => Buffer.byteLength(JSON.stringify(pane)));
  const envelope = Buffer.byteLength(JSON.stringify({ dateKey, panes: [] })) + Math.max(0, candidates.length - 1);
  const shares = fairShares(needs, maxPromptBytes - envelope);
  const included = [];
  const panes = [];
  candidates.forEach((source, index) => {
    const packed = shares[index] < needs[index] ? fittedPane(source, shares[index]) : wanted[index];
    const sourceText = JSON.stringify({ dateKey, panes: [...panes, packed.pane] });
    if (Buffer.byteLength(sourceText) > maxPromptBytes) {
      omitted.push({ ...source, omitReason: "total-byte-limit" });
      return;
    }
    panes.push(packed.pane);
    included.push(packed.source);
  });
  return {
    included,
    omitted,
    payload: { dateKey, panes },
    sourceText: JSON.stringify({ dateKey, panes }),
  };
}

/** WHAT: Checks the model product. WHY: Prevents unbounded or marker-bearing output from altering memory. */
export function validateDreamSummary(content, options = {}) {
  const text = String(content || "").trim();
  const maxBytes = options.maxBytes || DREAM_SUMMARY_BYTES;
  const maxLines = options.maxLines || DREAM_SUMMARY_LINES;
  const lines = text.split(/\r?\n/u).filter((line) => line.trim()).length;
  if (!text) return { ok: false, reason: "empty-summary" };
  if (Buffer.byteLength(text) > maxBytes) return { ok: false, reason: "summary-byte-limit" };
  if (lines > maxLines) return { ok: false, reason: "summary-line-limit" };
  if (/<!--\s*\/?amux-/iu.test(text)) return { ok: false, reason: "reserved-marker" };
  return { ok: true, content: text, lines };
}

/** WHAT: Formats the controller-owned daily block. WHY: Keeps model output outside reserved structural markers. */
export function dreamSummaryBlock(content, dateKey, included, omitted) {
  const body = String(content).trim();
  return [
    `<!-- amux-dream-summary:${dateKey} -->`,
    "## Nightly fleet summary",
    `> ${included.length} panel(s) included; ${omitted.length} omitted by fixed limits.`,
    "",
    body,
    `<!-- /amux-dream-summary:${dateKey} -->`,
  ].join("\n");
}

/** WHAT: Builds memory with one daily fleet block. WHY: Prevents retries from duplicating summaries. */
export function upsertDreamSummary(memory, dateKey, block) {
  const start = `<!-- amux-dream-summary:${dateKey} -->`;
  const end = `<!-- /amux-dream-summary:${dateKey} -->`;
  const startAt = memory.indexOf(start);
  const endAt = startAt < 0 ? -1 : memory.indexOf(end, startAt);
  if (startAt >= 0 && endAt >= 0) {
    return `${memory.slice(0, startAt).trimEnd()}\n\n${block}${memory.slice(endAt + end.length)}`;
  }
  return `${memory.trimEnd()}\n\n${block}\n`;
}
