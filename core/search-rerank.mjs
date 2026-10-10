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

const TEXT_CHARS = 1200;

/**
 * WHAT: Defines the GPU and CPU rerankers with their candidate budgets.
 * WHY: Keeps the strong model on the GPU and a fast fallback on the CPU on one contract.
 */
export const RERANKERS = {
  // bge-reranker-v2-m3 on the RTX 3090: 100 pairs in about 0.6 s. Golden dev
  // (147): alone it beat a 0.7 or 0.85 blend with the first stage (90 % vs
  // 85-88 % hit@3), and 100 candidates with 60 semantic hits beat 60/30.
  gpu: { model: "onnx-community/bge-reranker-v2-m3-ONNX", device: "cuda", dtype: "fp16", maxTokens: 256, chunk: 50,
    candidates: 100, semanticK: 60, perFile: 6, weight: 1 },
  cpu: { model: "cross-encoder/mmarco-mMiniLMv2-L12-H384-v1", device: "cpu", dtype: "fp32", maxTokens: 192, chunk: 30,
    candidates: 30, semanticK: 30, perFile: 2, weight: 0.3 },
};
/** WHAT: Names the CPU reranker model. WHY: Keeps docs and the fallback on one model id. */
export const RERANK_MODEL = RERANKERS.cpu.model;
/** WHAT: Defines how many candidates the CPU reranker reads. WHY: Keeps CPU rerank latency near 0.8 s. */
export const RERANK_CANDIDATES = RERANKERS.cpu.candidates;

/** WHAT: Loads one cross-encoder once per process. WHY: Keeps model load out of each query; only the daemon calls it. */
export async function loadReranker(kind = "cpu", { threads = Number(process.env.AMUX_RERANK_THREADS) || 6 } = {}) {
  const spec = RERANKERS[kind];
  const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
  env.cacheDir = modelCacheDir();
  const tokenizer = await AutoTokenizer.from_pretrained(spec.model);
  const net = await AutoModelForSequenceClassification.from_pretrained(spec.model, spec.device === "cuda"
    ? { device: "cuda", dtype: spec.dtype }
    : { dtype: spec.dtype, session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } });
  const score = async (query, texts) => {
    const scores = [];
    // Chunks bound the activation memory, which on the GPU is VRAM.
    for (let i = 0; i < texts.length; i += spec.chunk) {
      const part = texts.slice(i, i + spec.chunk);
      const { logits } = await net(tokenizer(part.map(() => query), { text_pair: part, padding: true, truncation: true, max_length: spec.maxTokens }));
      scores.push(...Array.from(logits.data));
    }
    return scores;
  };
  return { kind, ...spec, score };
}

// Weight of the cross-encoder against the first-stage order. MiniLM alone
// demoted answers both earlier layers agreed on (golden dev: 78 alone, 83
// blended at 0.3, 79 at 0.5).
const RERANK_WEIGHT = RERANKERS.cpu.weight;

/** WHAT: Returns the text the reranker reads for a hit: its headings and the unit. WHY: Keeps a bullet from losing the subject its heading names. */
export function rerankText(hit, read = (path) => readFileSync(path, "utf8")) {
  if (hit.topic) {
    // A topic page: its title and summary, then the body without metadata.
    let body = "";
    try { body = read(hit.path).split("\n").filter((line) => !/^(?:[\w-]+:|---|>|<!--)/u.test(line)).join("\n"); } catch { /* summary stays */ }
    return `${hit.snippet}\n${body}`.slice(0, TEXT_CHARS);
  }
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
