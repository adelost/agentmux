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
} from "../core/search.mjs";
import { defaultSearchStatePath, loadLastResults, saveLastResults } from "../core/search-state.mjs";
import { defaultWorkspace } from "../core/runtime-defaults.mjs";
import { expandMemoryTopic, isTopicPath, mergeTopicHits, searchMemoryTopics } from "../core/memory-topic-search.mjs";
import { expandPassage, mergePassageHits, searchPassages } from "../core/search-passages.mjs";
import { documentWindow, firstAnswerRank, formatEvalReport, parseGoldenCases, summarizeEval } from "../core/search-eval.mjs";
import { readFileSync } from "node:fs";

/** WHAT: Describes the search CLI contract. WHY: Keeps actual flags and user guidance in one place. */
export const SEARCH_HELP = `Usage:
  amux search "term" [--max N] [--source NAME]
  amux search "term" --raw          Original lexical search, omit topics/passages
  amux search "term" --deep         Include large raw session archives
  amux search "term" --semantic     Add the slower local semantic layer
  amux search "term" --show N       Search, then expand result N
  amux search --show N [--context N] Expand the last search result
  amux search --reindex              Rebuild the optional semantic index
  amux search --eval FILE [--split dev|heldout] [--semantic]
                                     Score a golden JSONL set: hit@1, hit@3, MRR, latency

Validated memory/topics pages provide compact orientation alongside original sources.
Current Markdown paragraphs also match natural questions without embeddings.
--raw disables these layers. Topic/paragraph expansion rechecks source hashes; use
amux memory topics --json to inspect states and decision cells. Topic text is
derived, not a new instruction or proof that no later correction exists.
Lexical search over memory and the durable AMUX delivery ledger remains available.
--deep adds large raw session archives. --semantic adds the local embedding
index and always reports its age.

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

/**
 * WHAT: Returns the ranked overview from every search layer for one query.
 * WHY: Keeps printing and the golden-set eval on exactly the same retrieval.
 */
export async function collectSearchHits(query, allRoots, workspace, flags = {}, { warn = console.warn } = {}) {
  const roots = flags.source ? allRoots.filter((root) => root.name.includes(flags.source)) : allRoots;
  const startedAt = Date.now();
  const ledgerRoot = roots.find((root) => root.kind === "event-ledger");
  const ledgerHits = ledgerRoot ? searchEventLedger(query, ledgerRoot.path) : [];
  // A relevant per-event receipt is higher-quality than file-level AND over
  // giant transcripts, and avoids a multi-second scan through unrelated
  // words in different turns. Exact phrase search still runs everywhere.
  const lexicalRoots = roots.filter((root) => root.kind !== "event-ledger"
    && !isTopicPath(root.path, workspace) && (flags.deep || root.semantic))
    .map(root => ({ ...root, exclude: [...root.exclude, `${workspace}/memory/topics/**`] }));
  let hits = lexicalSearch(query, lexicalRoots, {
    includeFileAnd: ledgerHits.length === 0,
  });
  if (ledgerHits.length) hits = dedupeByFile([...hits, ...ledgerHits]);
  if (flags.semantic && !flags.fast) {
    try {
      const sem = await import("../core/search-semantic.mjs");
      const status = sem.semanticIndexStatus();
      if (!status.available) {
        warn("⚠ semantic index missing; showing current lexical results. Run: amux search --reindex");
      } else {
        warn(`${status.stale ? "⚠" : "ℹ"} semantic index ${formatAge(status.ageMs)} · built ${status.builtAt}`);
      }
      const semanticHits = await sem.semanticSearch(query, { k: 8 });
      const allowedRoots = new Set(roots.map((root) => root.name));
      const scoped = (semanticHits || []).filter((hit) => allowedRoots.has(hit.root) && !isTopicPath(hit.path, workspace));
      if (scoped.length) {
        hits = dedupeByFile([...hits, ...scoped.map((hit) => withScore({ ...hit, layer: "sem" }))]);
      }
    } catch (error) {
      if (process.env.AMUX_DEBUG) console.error(`semantic layer off: ${error.message}`);
    }
  }

  hits = hits.filter(hit => !isTopicPath(hit.path, workspace));
  if (!flags.raw && !hits.some(hit => hit.layer === "L1" && !hit.path.endsWith(".jsonl"))) {
    hits = mergePassageHits(hits, searchPassages(query, lexicalRoots, {
      max: flags.max ?? 12, excludePath: path => isTopicPath(path, workspace),
    }));
  }
  let topicHits = [];
  if (!flags.raw && (!flags.source || "memory-topics".includes(flags.source))) {
    try {
      const result = searchMemoryTopics(query, workspace);
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
async function runSearchEval(file, roots, workspace, flags) {
  const split = flags.split || "all";
  const cases = parseGoldenCases(readFileSync(file, "utf8")).filter((row) => split === "all" || row.split === split);
  const rows = [];
  for (const row of cases) {
    const { top, elapsedMs } = await collectSearchHits(row.query, roots, workspace, flags, { warn: () => {} });
    const rank = firstAnswerRank(top, row.expect, { viewOf: expandedView });
    rows.push({ ...row, rank, ms: elapsedMs, top: top.map((hit) => `${hit.layer} ${hit.path.replace(`${process.env.HOME}/`, "~/")}:${hit.line}`) });
  }
  const label = `golden ${split} · ${flags.semantic ? "semantic" : "default"} · ${cases.length} questions`;
  console.log(formatEvalReport({ label, summary: summarizeEval(rows), rows }));
  return rows;
}

/** WHAT: Routes search, expansion and reindex requests. WHY: Keeps search state and source selection out of the command router. */
export async function cmdSearch(ctx, query, flags, dependencies = {}) {
  const statePath = dependencies.statePath || defaultSearchStatePath();
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

  if (flags.eval) return runSearchEval(flags.eval, roots, workspace, flags);
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
  const { top, total, elapsedMs } = await collectSearchHits(query, roots, workspace, flags);
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
