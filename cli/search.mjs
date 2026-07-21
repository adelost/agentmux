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
  saveLastResults,
  loadLastResults,
  expandHit,
  withScore,
  dedupeByFile,
} from "../core/search.mjs";

/** WHAT: Describes the search CLI contract. WHY: Keeps actual flags and user guidance in one place. */
export const SEARCH_HELP = `Usage:
  amux search "term" [--max N] [--source NAME] [--fast]
  amux search "term" --show N       Search, then expand result N
  amux search --show N [--context N] Expand the last search result
  amux search --reindex              Rebuild the optional semantic index

Searches configured memory/session roots plus the durable AMUX delivery ledger.`;

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
    console.log(expandHit(hit, { context: context ?? 10 }));
    console.log("");
  }
}

/** WHAT: Routes search, expansion and reindex requests. WHY: Keeps search state and source selection out of the command router. */
export async function cmdSearch(ctx, query, flags) {
  if (flags.help || flags.h) {
    console.log(SEARCH_HELP);
    return;
  }

  const config = loadConfig(ctx.configPath);
  let roots = withEventLedgerRoot(loadSearchRoots(config), eventsPath());

  if (flags.reindex) {
    const sem = await import("../core/search-semantic.mjs");
    return sem.reindex(roots, { log: console.log });
  }

  if (!query && flags.show != null) {
    showResults(loadLastResults(), flags.show, flags.context);
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
    && (!ledgerHits.length || root.semantic));
  let hits = lexicalSearch(query, lexicalRoots, {
    includeFileAnd: ledgerHits.length === 0,
  });
  if (ledgerHits.length) hits = dedupeByFile([...hits, ...ledgerHits]);
  if (!flags.fast) {
    try {
      const sem = await import("../core/search-semantic.mjs");
      const semanticHits = await sem.semanticSearch(query, { k: 8 });
      const allowedRoots = new Set(roots.map((root) => root.name));
      const scoped = (semanticHits || []).filter((hit) => allowedRoots.has(hit.root));
      if (scoped.length) {
        hits = dedupeByFile([...hits, ...scoped.map((hit) => withScore({ ...hit, layer: "sem" }))]);
      }
    } catch (error) {
      if (process.env.AMUX_DEBUG) console.error(`semantic layer off: ${error.message}`);
    }
  }

  const top = hits.slice(0, flags.max ?? 12);
  if (!top.length) {
    console.log(`0 träffar för "${query}" (${Date.now() - startedAt}ms)`);
    return;
  }
  const current = { query, ts: new Date().toISOString(), hits: top };
  saveLastResults(query, top);
  console.log(formatHits(top));
  console.log(`\n${top.length}/${hits.length} träffar, ${Date.now() - startedAt}ms  ·  expandera: amux search --show N`);
  if (flags.show != null) showResults(current, flags.show, flags.context);
}
