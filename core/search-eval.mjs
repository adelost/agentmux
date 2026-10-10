// Search quality is measured against real questions with known answers, not
// judged from a few hand-picked queries. A golden case names its expected
// answer by distinctive text, never by path, so moving or archiving a file
// does not turn a correct hit into a miss.

import { readFileSync } from "node:fs";

const ANSWER_WINDOW_LINES = 15;
const KINDS_ORDER = ["exact", "paraphrase", "decision", "recent", "people", "tried"];

const normalize = (text) => String(text ?? "").normalize("NFC").toLocaleLowerCase("sv-SE").replace(/\s+/gu, " ");

/** WHAT: Parses golden JSONL cases. WHY: Prevents malformed cases from skewing a score. */
export function parseGoldenCases(text) {
  return String(text).split("\n").map((line, index) => ({ line, index })).filter(({ line }) => line.trim())
    .map(({ line, index }) => {
      let row;
      try { row = JSON.parse(line); } catch { throw new Error(`golden line ${index + 1}: invalid JSON`); }
      const expect = Array.isArray(row.expect) ? row.expect.filter((value) => typeof value === "string" && value.trim()) : [];
      if (!row.id || !row.query || !expect.length) throw new Error(`golden line ${index + 1}: needs id, query and expect[]`);
      return { id: String(row.id), query: String(row.query), expect, kind: String(row.kind || "other"),
        split: row.split === "heldout" ? "heldout" : "dev" };
    });
}

/** WHAT: Reads the lines an agent sees when expanding a document hit. WHY: Prevents an answer far away in a huge daily file from counting as found. */
export function documentWindow(path, line, { readFile = readFileSync, radius = ANSWER_WINDOW_LINES } = {}) {
  const lines = readFile(path, "utf8").split("\n");
  const index = Math.max(0, (Number(line) || 1) - 1);
  return lines.slice(Math.max(0, index - radius), index + radius + 1).join("\n");
}

/** WHAT: Checks whether a hit shows any expected answer. WHY: Keeps the success rule identical for every layer. */
export function hitShowsAnswer(hit, expect, { viewOf }) {
  let view;
  try { view = viewOf(hit); } catch { return false; }
  const seen = normalize(`${hit.snippet || ""}\n${view || ""}`);
  return expect.some((text) => seen.includes(normalize(text)));
}

/** WHAT: Returns the 1-based rank of the first answering hit. WHY: Keeps hit@k and MRR on one shared definition of an answer. */
export function firstAnswerRank(hits, expect, dependencies) {
  const index = hits.findIndex((hit) => hitShowsAnswer(hit, expect, dependencies));
  return index < 0 ? null : index + 1;
}

const percentile = (values, fraction) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
};

function metrics(rows) {
  const n = rows.length;
  const within = (k) => rows.filter((row) => row.rank && row.rank <= k).length;
  return {
    n,
    hit1: n ? within(1) / n : 0,
    hit3: n ? within(3) / n : 0,
    mrr: n ? rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / n : 0,
    medianMs: percentile(rows.map((row) => row.ms), 0.5),
    p95Ms: percentile(rows.map((row) => row.ms), 0.95),
  };
}

/** WHAT: Returns eval metrics overall and per kind. WHY: Keeps weak question kinds visible instead of hiding them in one blended number. */
export function summarizeEval(rows) {
  const kinds = [...new Set(rows.map((row) => row.kind))]
    .sort((a, b) => (KINDS_ORDER.indexOf(a) + 1 || 99) - (KINDS_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
  return { overall: metrics(rows), byKind: Object.fromEntries(kinds.map((kind) => [kind, metrics(rows.filter((row) => row.kind === kind))])) };
}

const pct = (value) => `${Math.round(value * 100)}%`;
const ms = (value) => (value == null ? "-" : `${Math.round(value)}ms`);
const line = (label, m) => `${label.padEnd(12)} ${String(m.n).padStart(3)}  ${pct(m.hit1).padStart(5)}  ${pct(m.hit3).padStart(5)}  ${m.mrr.toFixed(2).padStart(5)}  ${ms(m.medianMs).padStart(7)}  ${ms(m.p95Ms).padStart(7)}`;

/** WHAT: Formats an eval summary and its misses. WHY: Keeps the score and the evidence for each failure on one screen. */
export function formatEvalReport({ label, summary, rows }) {
  const header = `${"set".padEnd(12)} ${"n".padStart(3)}  ${"hit@1".padStart(5)}  ${"hit@3".padStart(5)}  ${"MRR".padStart(5)}  ${"median".padStart(7)}  ${"p95".padStart(7)}`;
  const body = [line("overall", summary.overall), ...Object.entries(summary.byKind).map(([kind, m]) => line(`  ${kind}`, m))];
  const misses = rows.filter((row) => !row.rank || row.rank > 3).map((row) =>
    `  ${row.id} ${row.rank ? `rank ${row.rank}` : "miss"}  "${row.query}"\n${row.top.slice(0, 3).map((hit, i) => `      ${i + 1}. ${hit}`).join("\n") || "      (0 hits)"}`);
  const ranks = `Ranks: ${rows.map((row) => `${row.id}=${row.rank ?? "-"}`).join(" ")}`;
  return [`${label}`, header, ...body, ranks, ...(misses.length ? ["Not in top 3:", ...misses] : [])].join("\n");
}
