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

/** WHAT: Describes the search CLI contract. WHY: Keeps actual flags and user guidance in one place. */
export const SEARCH_HELP = `Usage:
  amux search "term" [--max N] [--source NAME]
  amux search "term" --raw          Original sources only, omit derived topics
  amux search "term" --deep         Include large raw session archives
  amux search "term" --semantic     Add the slower local semantic layer
  amux search "term" --show N       Search, then expand result N
  amux search --show N [--context N] Expand the last search result
  amux search --reindex              Rebuild the optional semantic index

Validated memory/topics pages provide compact orientation alongside original sources.
--raw disables this layer. Topic expansion rechecks the source hashes; use
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
    console.log(hit.topic ? expandMemoryTopic(hit) : expandHit(hit, { context: context ?? 10 }));
    console.log("");
  }
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
  let roots = withEventLedgerRoot(loadSearchRoots(config), eventsPath());

  if (flags.reindex) {
    const sem = await import("../core/search-semantic.mjs");
    return sem.reindex(roots, { log: console.log });
  }

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
  if (flags.source) roots = roots.filter((root) => root.name.includes(flags.source));

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
        console.warn("⚠ semantic index missing; showing current lexical results. Run: amux search --reindex");
      } else {
        console.warn(`${status.stale ? "⚠" : "ℹ"} semantic index ${formatAge(status.ageMs)} · built ${status.builtAt}`);
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
  let topicHits = [];
  if (!flags.raw && (!flags.source || "memory-topics".includes(flags.source))) {
    try {
      const result = searchMemoryTopics(query, workspace);
      topicHits = result.hits;
      if (result.excluded.length) console.warn(`Topics omitted: ${result.excluded.map(row => `${row.id}=${row.state}`).join(", ")}. Original-source search remains available.`);
    } catch (error) { console.warn(`Topic lookup unavailable: ${error.message}. Showing original-source results.`); }
  }
  const top = mergeTopicHits(hits, topicHits, flags.max ?? 12);
  if (!top.length) {
    console.log(`0 träffar för "${query}" (${Date.now() - startedAt}ms)`);
    return;
  }
  const current = { query, ts: new Date().toISOString(), hits: top };
  saveLastResults(query, top, statePath);
  console.log(formatHits(top));
  console.log(`\n${top.length}/${hits.length + topicHits.length} träffar, ${Date.now() - startedAt}ms  ·  expandera: amux search --show N`);
  if (flags.show != null) showResults(current, flags.show, flags.context);
}
