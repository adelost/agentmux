// Second-stage ranking for natural questions. A cross-encoder reads the
// question and each candidate unit together, so it can tell "bekant via
// Hinge" answers "hur träffades Mattias och Julia" even though no word is
// shared. It runs in the search daemon on the top candidates only.
//
// Model: cross-encoder/mmarco-mMiniLMv2-L12-H384-v1 (multilingual MiniLM,
// 118M). Golden dev 2026-10-10, 30 candidates at 192 tokens: bge-reranker-v2-m3
// ranked better alone but took 11 s per question on this CPU; MiniLM takes
// about 0.8 s and, blended with the first-stage order, lifted the full
// pipeline from 79 % to 85 % hit@3 (40 candidates at 160 tokens: 84 %).

import { readFileSync } from "node:fs";
import { modelCacheDir } from "./search-semantic.mjs";

/** WHAT: Names the cross-encoder model. WHY: Keeps the daemon and docs on one reranker. */
export const RERANK_MODEL = "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1";
/** WHAT: Defines how many first-stage candidates are reranked. WHY: Keeps rerank latency near 0.8 s on this CPU. */
export const RERANK_CANDIDATES = 30;
const MAX_TOKENS = 192;
const TEXT_CHARS = 1200;
// Weight of the cross-encoder against the first-stage order. The reranker
// alone demoted answers both earlier layers agreed on (golden dev: 78 alone,
// 83 blended at 0.3, 79 at 0.5).
const RERANK_WEIGHT = 0.3;

/** WHAT: Loads the cross-encoder once per process. WHY: Keeps model load out of each query; only the daemon calls it. */
export async function loadReranker({ model = RERANK_MODEL, threads = Number(process.env.AMUX_RERANK_THREADS) || 6 } = {}) {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
  env.cacheDir = modelCacheDir();
  const tokenizer = await AutoTokenizer.from_pretrained(model);
  const net = await AutoModelForSequenceClassification.from_pretrained(model, { dtype: "fp32",
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } });
  return async (query, texts) => {
    if (!texts.length) return [];
    const inputs = tokenizer(texts.map(() => query), { text_pair: texts, padding: true, truncation: true, max_length: MAX_TOKENS });
    const { logits } = await net(inputs);
    return Array.from(logits.data);
  };
}

/** WHAT: Returns the text the reranker reads for a hit: its headings and the unit. WHY: Keeps a bullet from losing the subject its heading names. */
export function rerankText(hit, read = (path) => readFileSync(path, "utf8")) {
  const context = (hit.passage?.context || []).join(" > ");
  let body = hit.snippet || "";
  if (hit.passage) {
    try { body = read(hit.path).slice(hit.passage.start, hit.passage.start + hit.passage.length); } catch { /* snippet stays */ }
  }
  return `${context}\n${body}`.slice(0, TEXT_CHARS);
}

/**
 * WHAT: Returns candidates reordered by a blend of reranker score and first-stage order.
 * WHY: Keeps answers both first-stage layers agree on from being demoted by the reranker alone.
 */
export function blendRerank(candidates, scores, { weight = RERANK_WEIGHT } = {}) {
  const n = candidates.length;
  if (n < 2 || scores.length !== n) return candidates;
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const blended = candidates.map((hit, index) => ({ hit, index,
    score: weight * (max > min ? (scores[index] - min) / (max - min) : 1) + (1 - weight) * (1 - index / (n - 1)) }));
  return blended.sort((a, b) => b.score - a.score || a.index - b.index).map(({ hit, score }) => ({ ...hit, rerankScore: score }));
}
