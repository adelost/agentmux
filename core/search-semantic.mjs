// Semantic layer for amux search — local CPU embeddings over the CURATED
// roots (memory markdown, digests), never raw session jsonl (gigabytes that
// rotate away after 14d; low value per token). Closes the paraphrase gap
// lexical search cannot: "löneförhöjning" must find the note that says
// "1k höjning" (benchmark 2026-07-10: 0 lexical hits).
//
// Model: Xenova/multilingual-e5-small via @huggingface/transformers —
// 384-dim, handles the Swedish/English mix, embeds this corpus in minutes
// on CPU. The dependency is OPTIONAL: importing this module throws if the
// package is missing, and cmdSearch degrades to lexical-only with a hint.
// No GPU involved by design (the 3090 is for heavy jobs).
//
// Index layout (~/.agentmux/search-index/):
//   meta.json    [{file, mtimeMs, root, chunks: [{line, text}]}] — text kept
//                for snippet display; corpus is small (MBs), not sessions.
//   vectors.bin  Float32Array rows in meta order, normalized (dot = cosine).

import { readFileSync, writeFileSync, statSync, mkdirSync } from "fs";
import { join } from "path";
import { dateFromPath, execRg } from "./search.mjs";

const DIM = 384;
const MODEL = "Xenova/multilingual-e5-small";
const INDEX_DIR = () => join(process.env.HOME, ".agentmux", "search-index");

let embedderPromise = null;
async function embedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const { pipeline } = await import("@huggingface/transformers");
      return pipeline("feature-extraction", MODEL);
    })();
  }
  return embedderPromise;
}

/** E5 convention: passages and queries carry distinct prefixes. */
async function embed(texts, kind) {
  const pipe = await embedder();
  const prefixed = texts.map((t) => `${kind}: ${t}`);
  const out = await pipe(prefixed, { pooling: "mean", normalize: true });
  // out.data is a flat Float32Array [n * DIM]
  const rows = [];
  for (let i = 0; i < texts.length; i++) {
    rows.push(out.data.slice(i * DIM, (i + 1) * DIM));
  }
  return rows;
}

/**
 * Heading-aware chunking: split on markdown headings, then pack paragraphs
 * up to maxChars. Each chunk remembers its 1-based start line so --show can
 * open the right spot in the file.
 */
export function chunkMarkdown(text, { maxChars = 1200 } = {}) {
  const lines = text.split("\n");
  const chunks = [];
  let buf = [];
  let bufStart = 1;
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t.length > 40) chunks.push({ line: bufStart, text: t.slice(0, maxChars * 2) });
    buf = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const isHeading = /^#{1,4}\s/.test(lines[i]);
    const tooBig = buf.join("\n").length > maxChars;
    if ((isHeading || tooBig) && buf.length) {
      flush();
      bufStart = i + 1;
    }
    buf.push(lines[i]);
  }
  flush();
  return chunks;
}

function listMarkdownFiles(root) {
  const args = ["--files", "--no-ignore", "--hidden", "-g", root.glob || "*.md"];
  // Lexical excludes apply here too, plus semantic-only ones: raw transcripts
  // and bulk reference material are grep-territory (huge, low curation) —
  // embedding them costs hours for marginal paraphrase recall. The knob makes
  // that tradeoff config, not code.
  for (const ex of root.exclude || []) args.push("-g", `!${ex}`);
  for (const ex of root.semanticExclude || []) args.push("-g", `!${ex}`);
  args.push(root.path);
  return execRg(args).split("\n").filter(Boolean);
}

function loadIndex() {
  const dir = INDEX_DIR();
  try {
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const buf = readFileSync(join(dir, "vectors.bin"));
    const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return { meta, vectors };
  } catch {
    return null;
  }
}

/**
 * (Re)build the index over semantic-enabled roots. Incremental: files whose
 * mtime matches the previous index keep their rows without re-embedding.
 */
export async function reindex(roots, { log = () => {} } = {}) {
  const semRoots = roots.filter((r) => r.semantic);
  if (!semRoots.length) {
    log("Inga rötter med semantic: true i config — inget att indexera.");
    return { files: 0, chunks: 0 };
  }
  const prev = loadIndex();
  const prevByFile = new Map();
  if (prev) {
    let row = 0;
    for (const f of prev.meta) {
      prevByFile.set(f.file, { ...f, firstRow: row });
      row += f.chunks.length;
    }
  }

  const meta = [];
  const rows = [];
  let reused = 0, embedded = 0;
  for (const root of semRoots) {
    for (const file of listMarkdownFiles(root)) {
      let mtimeMs;
      try { mtimeMs = statSync(file).mtimeMs; } catch { continue; }
      const old = prevByFile.get(file);
      if (old && old.mtimeMs === mtimeMs && prev) {
        meta.push({ file, mtimeMs, root: root.name, weight: root.weight, chunks: old.chunks });
        for (let i = 0; i < old.chunks.length; i++) {
          rows.push(prev.vectors.slice((old.firstRow + i) * DIM, (old.firstRow + i + 1) * DIM));
        }
        reused += old.chunks.length;
        continue;
      }
      const chunks = chunkMarkdown(readFileSync(file, "utf-8"));
      if (!chunks.length) continue;
      // Batch to keep peak memory flat on big transcript files.
      for (let i = 0; i < chunks.length; i += 32) {
        const batch = chunks.slice(i, i + 32);
        rows.push(...await embed(batch.map((c) => c.text), "passage"));
      }
      embedded += chunks.length;
      meta.push({ file, mtimeMs, root: root.name, weight: root.weight, chunks });
      if (embedded % 320 < chunks.length % 320) log(`  ${embedded} chunks embeddade...`);
    }
  }

  const dir = INDEX_DIR();
  mkdirSync(dir, { recursive: true });
  const flat = new Float32Array(rows.length * DIM);
  rows.forEach((r, i) => flat.set(r, i * DIM));
  writeFileSync(join(dir, "vectors.bin"), Buffer.from(flat.buffer));
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  log(`Index klart: ${meta.length} filer, ${rows.length} chunks (${embedded} nya, ${reused} återanvända).`);
  return { files: meta.length, chunks: rows.length };
}

/** Top-k cosine over the index. Returns search.mjs-shaped hits. */
export async function semanticSearch(query, { k = 8, minScore = 0.80 } = {}) {
  const index = loadIndex();
  if (!index) throw new Error("inget semantiskt index — kör: amux search --reindex");
  const [q] = await embed([query], "query");

  const flat = [];
  let row = 0;
  for (const f of index.meta) {
    for (const c of f.chunks) flat.push({ file: f.file, root: f.root, weight: f.weight, chunk: c, row: row++ });
  }
  const scored = flat.map((entry) => {
    let dot = 0;
    const off = entry.row * DIM;
    for (let i = 0; i < DIM; i++) dot += q[i] * index.vectors[off + i];
    return { ...entry, sim: dot };
  });
  scored.sort((a, b) => b.sim - a.sim);
  return scored.slice(0, k)
    .filter((e) => e.sim >= minScore)
    .map((e) => ({
      path: e.file,
      line: e.chunk.line,
      snippet: e.chunk.text.replace(/\s+/g, " ").slice(0, 160),
      root: e.root,
      weight: e.weight,
      date: dateFromPath(e.file),
      sim: Number(e.sim.toFixed(3)),
    }));
}
