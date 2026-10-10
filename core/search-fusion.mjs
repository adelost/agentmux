// Combines the lexical passage ranking with the semantic ranking. Exact names
// and identifiers stay lexical: an embedding of "GRACE_S" says little, while
// ripgrep finds it instantly. For natural questions a unit both layers rank
// well rises, and one only the paraphrase-aware layer finds can still enter
// the top results.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const FUSION_ALPHA = 0.6;
const STOP = new Set("a an and are as att av de den det do du då eller en ett får för från ha har hur i in inte jag kan man med mig min mitt och of om on på som the till to vad var vi vilken vilket vilka varför är när is it was who what why how".split(" "));

/**
 * WHAT: Returns "exact" for identifiers and short names, else "natural".
 * WHY: Keeps semantic noise away from lookups that exact matching answers.
 */
export function classifyQuery(query) {
  const raw = String(query).trim();
  if (/[`"']/u.test(raw)) return "exact";
  const words = raw.split(/\s+/u).filter(Boolean);
  const content = words.filter((word) => !STOP.has(word.toLowerCase().replace(/[?!.,]+$/u, "")));
  if (content.length <= 2 && words.length <= 3) return "exact";
  if (words.length <= 3 && words.some((word) => /[\w][./_:@#][\w]/u.test(word))) return "exact";
  return "natural";
}

const keyOf = (hit) => `${hit.path}:${hit.passage ? `@${hit.passage.start}` : `L${hit.line}`}`;

// Reciprocal-rank fusion ignored that BM25 often has one clear winner and
// lifted units both layers found only moderately above it (golden dev
// 2026-10-10: hit@3 81 % lexical, 75 % with RRF, 85 % with score fusion).
// Each layer's scores are min-max normalised; alpha weights lexical.
/**
 * WHAT: Returns one ranking from lexical and semantic hits by normalised score.
 * WHY: Keeps a clear lexical winner from losing to units both layers rank weakly.
 */
export function fuseRankings(lexical, semantic, { alpha = FUSION_ALPHA } = {}) {
  const normalise = (list, value) => {
    const values = list.map(value);
    const max = Math.max(...values);
    const min = Math.min(...values);
    return (hit) => (max > min ? (value(hit) - min) / (max - min) : 1);
  };
  const lexicalScore = normalise(lexical, (hit) => hit.score);
  const semanticScore = normalise(semantic, (hit) => hit.sim);
  const fused = new Map();
  for (const hit of lexical) fused.set(keyOf(hit), { hit, score: alpha * lexicalScore(hit), layers: new Set(["passage"]) });
  for (const hit of semantic) {
    const key = keyOf(hit);
    const entry = fused.get(key) || { hit, score: 0, layers: new Set() };
    entry.score += (1 - alpha) * semanticScore(hit);
    entry.layers.add("sem");
    fused.set(key, entry);
  }
  return [...fused.values()].sort((a, b) => b.score - a.score)
    .map(({ hit, score, layers }) => ({ ...hit, fusedScore: score, layer: layers.has("passage") ? "passage" : "sem",
      ...(layers.size > 1 ? { fusedLayers: [...layers].sort() } : {}) }));
}

// A unit is expandable as a verified passage only while its file is the
// version that was indexed; a file changed since then is shown by line.
/**
 * WHAT: Turns daemon unit hits into search hits bound to the current file.
 * WHY: Prevents stale index offsets from presenting the wrong text after an edit.
 */
export function semanticSearchHits(hits, { read = readFileSync, stat = statSync } = {}) {
  const files = new Map();
  const current = (path) => {
    if (!files.has(path)) {
      try {
        const info = stat(path);
        const bytes = read(path);
        files.set(path, { mtimeMs: info.mtimeMs, size: info.size, bytes, text: bytes.toString("utf8"),
          sha256: createHash("sha256").update(bytes).digest("hex") });
      } catch { files.set(path, null); }
    }
    return files.get(path);
  };
  return hits.flatMap((hit) => {
    const file = current(hit.path);
    if (!file) return [];
    const { start, length, section } = hit.unit;
    const base = { path: hit.path, line: hit.line, root: hit.root, weight: hit.weight, date: hit.date, layer: "sem", sim: hit.sim };
    if (file.mtimeMs === hit.indexedMtimeMs && file.size === hit.indexedSize && start + length <= file.text.length) {
      const text = file.text.slice(start, start + length);
      return [{ ...base, snippet: text.replace(/\s+/gu, " ").slice(0, 160), passage: { sha256: file.sha256, start, length, section } }];
    }
    const line = file.text.split("\n")[hit.line - 1];
    return line === undefined ? [] : [{ ...base, snippet: line.replace(/\s+/gu, " ").slice(0, 160) }];
  });
}
