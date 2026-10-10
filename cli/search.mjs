// Search CLI kept separate from the command router: query, persisted result
// expansion and optional semantic lookup form one small subsystem.

import { loadConfig } from "./config.mjs";
import { eventsPath } from "../core/events.mjs";
import {
  loadSearchRoots,
  withEventLedgerRoot,
  searchEventLedger,
  lexicalSearch,
  formatHits,
  expandHit,
  withScore,
  dedupeByFile,
  escapeRegex,
} from "../core/search.mjs";
import { defaultSearchStatePath, loadLastResults, saveLastResults } from "../core/search-state.mjs";
import { defaultWorkspace } from "../core/runtime-defaults.mjs";
import { expandMemoryTopic, isTopicPath, mergeTopicHits, searchMemoryTopics } from "../core/memory-topic-search.mjs";
import { expandPassage, mergePassageHits, phraseUnits, searchPassages } from "../core/search-passages.mjs";
import { preferDates, temporalIntent } from "../core/search-time.mjs";
import { documentWindow, firstAnswerRank, formatEvalReport, parseGoldenCases, summarizeEval } from "../core/search-eval.mjs";
import { classifyQuery, fuseRankings, semanticSearchHits } from "../core/search-fusion.mjs";
import { daemonPassages, daemonRerank, semanticQuery } from "../core/search-embedder.mjs";
import { blendRerank, RERANK_CANDIDATES, rerankText } from "../core/search-rerank.mjs";
import { readFileSync } from "node:fs";

/** WHAT: Describes the search CLI contract. WHY: Keeps actual flags and user guidance in one place. */
export const SEARCH_HELP = `Usage:
  amux search "term" [--max N] [--source NAME]
  amux search "term" --raw          Original lexical search, omit topics/passages/semantic
  amux search "term" --lexical      Skip the semantic layer
  amux search "term" --deep         Include large raw session archives
  amux search "term" --semantic     Use the semantic layer even for exact lookups
  amux search "term" --show N       Search, then expand result N
  amux search --show N [--context N] Expand the last search result
  amux search --reindex              Update the semantic unit index (incremental)
  amux search --eval FILE [--split dev|heldout] [--lexical]
                                     Score a golden JSONL set: hit@1, hit@3, MRR, latency

Natural questions combine ranked note items (bullets, entries, table rows) with
the local semantic layer, then a cross-encoder reorders the top 30; identifiers
and one- or two-word names stay lexical, and an exact hit opens the units that
hold the phrase. Relative time ("i går", "i förmiddags", "last week") prefers
that day's notes. The semantic layer runs in a small background process that
loads on the first question, follows notes edited since the nightly index and
exits when idle; until it is warm a question is answered lexically and says
so. A passage expands with its section around it.
Validated memory/topics pages provide compact orientation alongside original sources.
--raw disables these layers. Topic/paragraph expansion rechecks source hashes; use
amux memory topics --json to inspect states and decision cells. Topic text is
derived, not a new instruction or proof that no later correction exists.
Lexical search over memory and the durable AMUX delivery ledger remains available.
--deep adds large raw session archives.

Journal hits show event time (unknown if absent), role and exact source line.
USER means authored journal input, not proof of a human order or current policy.
Ranking does not decide which decision supersedes another; expand the source.
Journals retain the latest 12 distinct matching events per root. Word-AND is
within one event, never across unrelated turns. Mirror encodings share one hit.
--context counts physical JSONL neighbors (max 20 per side). Quotes preserve
whitespace; limits are explicit: 16k characters per event, 32k per expansion.
Events over 4 MiB are omitted with an explicit incomplete-search warning;
later events are still searched. There is no journal file-size cap.
New hits seek directly; older saved hits stream to their line with bounded memory.`;

function formatAge(ms) {
  if (!Number.isFinite(ms)) return "unknown age";
  const hours = Math.floor(ms / 3_600_000);
  return hours < 48 ? `${hours}h old` : `${Math.floor(hours / 24)}d old`;
}

function showResults(last, show, context) {
  if (!last) {
    console.error("Ingen tidigare sökning att expandera.");
    process.exitCode = 1;
    return;
  }
  const picks = String(show).split(",").map((n) => parseInt(n, 10)).filter(Boolean);
  for (const n of picks) {
    const hit = last.hits[n - 1];
    if (!hit) {
      console.error(`#${n} finns inte (sökningen gav ${last.hits.length} träffar).`);
      continue;
    }
    console.log(`── #${n} ${hit.path}:${hit.line}  (sökning: "${last.query}")`);
    console.log(hit.topic ? expandMemoryTopic(hit) : hit.passage ? expandPassage(hit) : expandHit(hit, { context: context ?? 10 }));
    console.log("");
  }
}

/** WHAT: Names the warm-daemon semantic layer. WHY: Keeps tests and callers able to substitute it without a model. */
export const SEMANTIC_LAYER = Object.freeze({ query: semanticQuery, passages: daemonPassages, rerank: daemonRerank });

/**
 * WHAT: Returns the ranked overview from every search layer for one query.
 * WHY: Keeps printing and the golden-set eval on exactly the same retrieval.
 */
export async function collectSearchHits(query, allRoots, workspace, flags = {}, { warn = console.warn, semantic = SEMANTIC_LAYER } = {}) {
  const roots = flags.source ? allRoots.filter((root) => root.name.includes(flags.source)) : allRoots;
  const startedAt = Date.now();
  const { query: content, dates } = temporalIntent(query, flags.now ? new Date(flags.now) : new Date());
  const ledgerRoot = roots.find((root) => root.kind === "event-ledger");
  const ledgerHits = ledgerRoot ? searchEventLedger(content, ledgerRoot.path) : [];
  // A relevant per-event receipt is higher-quality than file-level AND over
  // giant transcripts, and avoids a multi-second scan through unrelated
  // words in different turns. Exact phrase search still runs everywhere.
  const lexicalRoots = roots.filter((root) => root.kind !== "event-ledger"
    && !isTopicPath(root.path, workspace) && (flags.deep || root.semantic))
    .map(root => ({ ...root, exclude: [...root.exclude, `${workspace}/memory/topics/**`] }));
  // File-level word-AND (L2) runs one ripgrep pass per word, most of a
  // query's lexical cost. Ranked note items answer the same questions better,
  // so L2 is kept for --raw and for questions the item layers cannot rank.
  const fileAnd = ledgerHits.length === 0;
  let hits = lexicalSearch(content, lexicalRoots, { includeFileAnd: fileAnd && Boolean(flags.raw) });
  if (ledgerHits.length) hits = dedupeByFile([...hits, ...ledgerHits]);
  hits = hits.filter(hit => !isTopicPath(hit.path, workspace));
  // An exact Markdown hit opens the units that hold the phrase, not only the
  // first matching line of the file.
  const phrase = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegex(content)}(?![\\p{L}\\p{N}_])`, "iu");
  hits = hits.flatMap(hit => {
    if (hit.layer !== "L1" || hit.path.endsWith(".jsonl")) return [hit];
    try {
      const units = phraseUnits(hit, phrase);
      return units.length ? units : [hit];
    } catch { return [hit]; }
  });

  const exactDocument = hits.some(hit => hit.layer === "L1" && !hit.path.endsWith(".jsonl"));
  const passageMax = Math.max(flags.max ?? 12, 30);
  const passages = flags.raw || exactDocument ? []
    : await semantic.passages(content, lexicalRoots, { max: passageMax, workspace, dates })
      ?? searchPassages(content, lexicalRoots, { max: passageMax, dates, excludePath: path => isTopicPath(path, workspace) });
  let semanticHits = [];
  const useSemantic = !flags.raw && !flags.lexical && !flags.fast && (flags.semantic || classifyQuery(content) === "natural");
  if (useSemantic) {
    const allowedRoots = new Set(roots.map(root => root.name));
    const result = await semantic.query(content, { k: 30, roots: lexicalRoots, waitMs: flags.semanticWaitMs ?? 0 });
    if (result.unavailable) warn(`⚠ ${result.unavailable}`);
    else if (result.complete === false) warn("ℹ semantic index is still being built; recent files may be missing from the semantic layer");
    semanticHits = semanticSearchHits((result.hits || []).filter(hit => allowedRoots.has(hit.root) && !isTopicPath(hit.path, workspace)));
  }
  let ranked = semanticHits.length ? fuseRankings(passages, semanticHits) : passages;
  if (semanticHits.length && semantic.rerank && !flags.noRerank) {
    const candidates = ranked.slice(0, RERANK_CANDIDATES);
    const files = new Map();
    const read = (path) => { if (!files.has(path)) files.set(path, readFileSync(path, "utf8")); return files.get(path); };
    const { scores, unavailable } = await semantic.rerank(content, candidates.map((hit) => rerankText(hit, read)));
    if (scores) ranked = [...blendRerank(candidates, scores), ...ranked.slice(RERANK_CANDIDATES)];
    else warn(`ℹ ${unavailable}; showing first-stage order`);
  }
  ranked = preferDates(ranked, dates);
  if (fileAnd && !flags.raw && !exactDocument && ranked.length < 3) {
    const fileLevel = lexicalSearch(content, lexicalRoots, { includeFileAnd: true }).filter(hit => hit.layer === "L2"
      && !isTopicPath(hit.path, workspace));
    hits = dedupeByFile([...hits, ...fileLevel]);
  }
  if (ranked.length) hits = mergePassageHits(hits, ranked.slice(0, flags.max ?? 12));
  hits = preferDates(hits, dates);
  let topicHits = [];
  if (!flags.raw && (!flags.source || "memory-topics".includes(flags.source))) {
    try {
      const result = searchMemoryTopics(content, workspace);
      topicHits = result.hits;
      if (result.excluded.length) warn(`Topics omitted: ${result.excluded.map(row => `${row.id}=${row.state}`).join(", ")}. Original-source search remains available.`);
    } catch (error) { warn(`Topic lookup unavailable: ${error.message}. Showing original-source results.`); }
  }
  const top = mergeTopicHits(hits, topicHits, flags.max ?? 12);
  return { top, total: hits.length + topicHits.length, elapsedMs: Date.now() - startedAt };
}

/** WHAT: Renders what an agent sees after expanding a hit. WHY: Scores answers that are actually in view, per layer. */
function expandedView(hit) {
  if (hit.topic) return expandMemoryTopic(hit);
  if (hit.passage) return expandPassage(hit);
  if (hit.path.endsWith(".jsonl")) return expandHit(hit, { context: 0 });
  return documentWindow(hit.path, hit.line);
}

/** WHAT: Scores search against a golden question set. WHY: Turns "search feels fine" into hit@k, MRR and latency per kind of question. */
async function runSearchEval(file, roots, workspace, flags, semantic) {
  const split = flags.split || "all";
  const cases = parseGoldenCases(readFileSync(file, "utf8")).filter((row) => split === "all" || row.split === split);
  const rows = [];
  let warmup = null;
  if (!flags.raw && !flags.lexical) {
    // Latency rows measure the warm daemon users normally hit; the cold
    // start is reported once instead of inflating the first question.
    const startedAt = Date.now();
    const result = await semantic.query("warmup", { k: 1, waitMs: 180_000 });
    // The reranker loads after the embedder; wait for it too, so every row
    // measures the same warm pipeline.
    let reranker = Boolean(result.unavailable) || !semantic.rerank;
    for (let tries = 0; !reranker && tries < 240; tries++) {
      reranker = Boolean((await semantic.rerank("warmup", ["warmup"])).scores);
      if (!reranker) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    warmup = result.unavailable ? `semantic unavailable: ${result.unavailable}`
      : `semantic warm-up ${Date.now() - startedAt}ms${reranker && semantic.rerank ? "" : ", reranker unavailable"}`;
  }
  for (const row of cases) {
    // Relative time in a question ("i går") means the day it was written.
    const caseFlags = row.asOf ? { ...flags, now: `${row.asOf}T12:00:00` } : flags;
    const { top, elapsedMs } = await collectSearchHits(row.query, roots, workspace, caseFlags, { warn: () => {}, semantic });
    const rank = firstAnswerRank(top, row.expect, { viewOf: expandedView });
    rows.push({ ...row, rank, ms: elapsedMs, top: top.map((hit) => `${hit.layer} ${hit.path.replace(`${process.env.HOME}/`, "~/")}:${hit.line}`) });
  }
  const mode = flags.raw ? "raw" : flags.lexical ? "lexical" : flags.semantic ? "semantic-all" : "default";
  const label = `golden ${split} · ${mode} · ${cases.length} questions${warmup ? ` · ${warmup}` : ""}`;
  console.log(formatEvalReport({ label, summary: summarizeEval(rows), rows }));
  return rows;
}

/** WHAT: Routes search, expansion and reindex requests. WHY: Keeps search state and source selection out of the command router. */
export async function cmdSearch(ctx, query, flags, dependencies = {}) {
  const statePath = dependencies.statePath || defaultSearchStatePath();
  const semantic = dependencies.semantic || SEMANTIC_LAYER;
  if (flags.help || flags.h) {
    console.log(SEARCH_HELP);
    return;
  }

  const config = loadConfig(ctx.configPath);
  const workspace = flags.workspace || process.env.OPENCLAW_WORKSPACE || defaultWorkspace(process.env.HOME);
  const roots = withEventLedgerRoot(loadSearchRoots(config), eventsPath());

  if (flags.reindex) {
    const sem = await import("../core/search-semantic.mjs");
    return sem.reindex(roots, { log: console.log });
  }

  if (flags.eval) return runSearchEval(flags.eval, roots, workspace, flags, semantic);
  if (!query && flags.show != null) {
    showResults(loadLastResults(statePath), flags.show, flags.context);
    return;
  }
  if (!query) {
    console.error(SEARCH_HELP);
    process.exitCode = 1;
    return;
  }
  if (!roots.length) {
    console.error("Inga sökrötter kunde läsas. Kontrollera agentmux.yaml och ~/.agentmux/events.jsonl.");
    process.exitCode = 1;
    return;
  }
  const { top, total, elapsedMs } = await collectSearchHits(query, roots, workspace, flags, { semantic });
  if (!top.length) {
    console.log(`0 träffar för "${query}" (${elapsedMs}ms)`);
    return;
  }
  const current = { query, ts: new Date().toISOString(), hits: top };
  saveLastResults(query, top, statePath);
  console.log(formatHits(top));
  console.log(`\n${top.length}/${total} träffar, ${elapsedMs}ms  ·  expandera: amux search --show N`);
  if (flags.show != null) showResults(current, flags.show, flags.context);
}
