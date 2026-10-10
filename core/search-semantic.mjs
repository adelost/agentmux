// Semantic layer for amux search: local CPU embeddings over the curated
// memory roots, never raw session JSONL. It closes the gap lexical search
// cannot: a question worded differently from the note ("organiserade" vs
// "ORGANIZED BY", "taktkontrollen" vs "taktkoll"). No GPU by design.
//
// The index embeds the same item-sized units the passage layer ranks
// (core/search-units.mjs), each prefixed with its title, heading path and
// entry name, so a semantic hit and a lexical hit on the same bullet are the
// same unit and fuse cleanly.
//
// Models download once into a cache outside the install
// (~/.cache/agentmux/models): the package's own default cache lived inside
// node_modules, so every amux release deleted it and the next query paid the
// download again.
//
// Index layout (~/.agentmux/search-index/):
//   meta.json    {schemaVersion 3, model, dimension, complete, files: [{file,
//                mtimeMs, size, root, weight, units: [{line, start, length,
//                section}]}]}
//   vectors.bin  Float32 rows in meta order, normalized (dot = cosine).

import { readFileSync, writeFileSync, statSync, mkdirSync, renameSync } from "fs";
import { createHash } from "crypto";
import { basename, join } from "path";
import { dateFromPath, execRg } from "./search.mjs";
import { markdownUnits } from "./search-units.mjs";

/** WHAT: Names the unit index layout version. WHY: Keeps old chunk indexes from being read as unit indexes. */
export const SCHEMA_VERSION = 3;
/** WHAT: Names the default embedding model. WHY: Keeps index and query on one model unless configured otherwise. */
export const DEFAULT_MODEL = "Xenova/multilingual-e5-small";
const MODELS = {
  "Xenova/multilingual-e5-small": { pooling: "mean", query: "query: ", passage: "passage: " },
  "Xenova/multilingual-e5-base": { pooling: "mean", query: "query: ", passage: "passage: " },
  "onnx-community/gte-multilingual-base": { pooling: "cls", query: "", passage: "" },
};
const EMBED_CHARS = 1200;
const BATCH = 32;

/** WHAT: Resolves the semantic index directory. WHY: Keeps tests and experiments off the live index. */
export const indexDir = () => process.env.AMUX_SEARCH_INDEX_DIR || join(process.env.HOME, ".agentmux", "search-index");
/** WHAT: Resolves the model cache outside the install. WHY: Keeps releases from deleting downloaded models. */
export const modelCacheDir = () => join(process.env.HOME, ".cache", "agentmux", "models");

/** WHAT: Resolves the configured embedding model. WHY: Keeps index and query on one model, with prefixes that model expects. */
export function semanticModel(name = process.env.AMUX_SEARCH_MODEL || DEFAULT_MODEL) {
  const spec = MODELS[name];
  if (!spec) throw new Error(`unknown semantic model ${name}; supported: ${Object.keys(MODELS).join(", ")}`);
  return { name, ...spec };
}

// Threads: the machine is shared with many agents. A query is one short text
// (2 threads suffice); a full reindex used ~17 cores and 3 GB RSS unbounded,
// so it defaults to 6 threads (AMUX_EMBED_THREADS) and takes longer instead.
/** WHAT: Loads a feature-extraction pipeline once per process. WHY: Keeps model load out of every query; the daemon keeps one warm. */
export async function loadEmbedder(model = semanticModel(), { threads = Number(process.env.AMUX_EMBED_THREADS) || 6 } = {}) {
  const { pipeline, env } = await import("@huggingface/transformers");
  env.cacheDir = modelCacheDir();
  const pipe = await pipeline("feature-extraction", model.name, { dtype: "q8",
    session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } });
  return async (texts, kind) => {
    const prefix = kind === "query" ? model.query : model.passage;
    const out = await pipe(texts.map((text) => `${prefix}${text}`), { pooling: model.pooling, normalize: true });
    const dim = out.dims[1];
    return texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
  };
}

/**
 * WHAT: Parses Markdown into heading-aware chunks with start lines.
 * WHY: Keeps section-sized text available to callers; the index uses item units.
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

/** WHAT: Returns the text embedded for one unit, prefixed with its headings. WHY: Keeps a bullet from losing which project or person it concerns. */
export function unitEmbeddingText(file, text, unit) {
  const title = text.match(/^# (.+)$/mu)?.[1] || basename(file, ".md");
  const context = [title, ...unit.headings.filter((heading) => heading !== title), ...(unit.entry ? [unit.entry] : []),
    ...(unit.tableHeader ? [unit.tableHeader] : [])];
  return `${context.join(" > ")}\n${unit.text}`.slice(0, EMBED_CHARS);
}

/** WHAT: Names an embedding input by content. WHY: Keeps an unchanged unit's vector reusable after its file was edited. */
export const unitHash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** WHAT: Returns a file's units with their embedding text and content hash. WHY: Keeps reindex and the live overlay on one definition of a unit. */
export function fileUnits(file, text) {
  return markdownUnits(text).map((unit) => {
    const embedText = unitEmbeddingText(file, text, unit);
    return { line: unit.line, start: unit.start, length: unit.length, section: unit.section, hash: unitHash(embedText), embedText };
  });
}

/** WHAT: Returns the Markdown files a semantic root covers. WHY: Keeps reindex and the live overlay on the same file set. */
export function listMarkdownFiles(root) {
  const args = ["--files", "--no-ignore", "--hidden", "-g", root.glob || "*.md"];
  for (const ex of root.exclude || []) args.push("-g", `!${ex}`);
  for (const ex of root.semanticExclude || []) args.push("-g", `!${ex}`);
  args.push(root.path);
  return execRg(args).split("\n").filter(Boolean).sort();
}

function loadIndex(dir = indexDir()) {
  try {
    const raw = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    const meta = Array.isArray(raw) ? raw : raw.files;
    if (!Array.isArray(meta)) return null;
    const buf = readFileSync(join(dir, "vectors.bin"));
    const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const builtAt = Array.isArray(raw)
      ? new Date(statSync(join(dir, "meta.json")).mtimeMs).toISOString()
      : raw.builtAt;
    return { meta, vectors, builtAt, schemaVersion: raw.schemaVersion || 1, model: raw.model || null,
      dimension: raw.dimension || 384, complete: raw.complete !== false };
  } catch {
    return null;
  }
}

/** WHAT: Reports semantic-index provenance. WHY: Prevents old embeddings from masquerading as current search truth. */
export function semanticIndexStatus({ now = Date.now(), maxAgeMs = 36 * 60 * 60 * 1000, indexDir: dir = indexDir(),
  model = process.env.AMUX_SEARCH_MODEL || DEFAULT_MODEL } = {}) {
  const index = loadIndex(dir);
  if (!index) return { available: false, usable: false, stale: true, reason: "missing" };
  const builtMs = Date.parse(index.builtAt || "");
  const ageMs = Number.isFinite(builtMs) ? Math.max(0, now - builtMs) : Number.POSITIVE_INFINITY;
  const usable = index.schemaVersion === SCHEMA_VERSION && index.model === model;
  return {
    available: true,
    usable,
    reason: usable ? null : `index schema ${index.schemaVersion}/${index.model || "unknown model"} needs a rebuild for ${model}`,
    stale: !Number.isFinite(ageMs) || ageMs > maxAgeMs,
    complete: index.complete,
    builtAt: index.builtAt || null,
    ageMs,
    files: index.meta.length,
    chunks: index.meta.reduce((sum, file) => sum + ((file.units || file.chunks)?.length || 0), 0),
    schemaVersion: index.schemaVersion,
    model: index.model,
  };
}

// Nightly runs embed only what changed; maxUnits bounds a night after a model
// change, and the next run continues where it stopped.
/**
 * WHAT: Builds the unit index, reusing rows of files whose mtime and size match.
 * WHY: Keeps a model change or backlog from turning one night into hours of embedding.
 */
export async function reindex(roots, { log = () => {}, maxUnits = Number(process.env.AMUX_REINDEX_MAX_UNITS) || 25_000,
  dir = indexDir(), embed = null, model = semanticModel() } = {}) {
  const semRoots = roots.filter((root) => root.semantic);
  if (!semRoots.length) {
    log("Inga rötter med semantic: true i config — inget att indexera.");
    return { files: 0, chunks: 0 };
  }
  const startedAt = Date.now();
  const prev = loadIndex(dir);
  const compatible = prev && prev.schemaVersion === SCHEMA_VERSION && prev.model === model.name;
  const prevByFile = new Map();
  // Edited files keep the vectors of their unchanged units: a daily note that
  // grew by ten bullets re-embeds ten units, not the whole day.
  const prevByHash = new Map();
  const rowOf = (index) => prev.vectors.slice(index * prev.dimension, (index + 1) * prev.dimension);
  if (compatible) {
    let row = 0;
    for (const file of prev.meta) {
      prevByFile.set(file.file, { ...file, firstRow: row });
      file.units.forEach((unit, i) => { if (unit.hash) prevByHash.set(unit.hash, row + i); });
      row += file.units.length;
    }
  }
  const embedder = embed || await loadEmbedder(model);
  const meta = [];
  const rows = [];
  const pending = [];
  let reused = 0;
  let deferred = 0;
  for (const root of semRoots) {
    for (const file of listMarkdownFiles(root)) {
      let stat;
      try { stat = statSync(file); } catch { continue; }
      const old = prevByFile.get(file);
      const unchanged = old && old.mtimeMs === stat.mtimeMs && old.size === stat.size;
      if (unchanged && old.units.every((unit) => unit.hash)) {
        meta.push(old);
        for (let i = 0; i < old.units.length; i++) rows.push(rowOf(old.firstRow + i));
        reused += old.units.length;
        continue;
      }
      const text = readFileSync(file, "utf-8");
      const units = fileUnits(file, text);
      if (!units.length) continue;
      // Older indexes lack content hashes; an unchanged file gains them here
      // without re-embedding, provided its units still line up.
      const aligned = unchanged && old.units.length === units.length
        && old.units.every((unit, i) => unit.start === units[i].start && unit.length === units[i].length);
      const missing = aligned ? 0 : units.filter((unit) => !prevByHash.has(unit.hash)).length;
      if (missing && pending.length + missing > maxUnits) { deferred++; continue; }
      meta.push({ file, mtimeMs: stat.mtimeMs, size: stat.size, root: root.name, weight: root.weight,
        units: units.map(({ line, start, length, section, hash }) => ({ line, start, length, section, hash })) });
      units.forEach((unit, i) => {
        const known = aligned ? old.firstRow + i : prevByHash.get(unit.hash);
        if (known !== undefined) {
          rows.push(rowOf(known));
          reused++;
        } else {
          pending.push({ row: rows.length, text: unit.embedText });
          rows.push(null);
        }
      });
    }
  }
  // Similar lengths per batch: padding to the longest member wasted most of
  // the CPU time with mixed one-line and long units.
  pending.sort((a, b) => a.text.length - b.text.length);
  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    const vectors = await embedder(batch.map((item) => item.text), "passage");
    batch.forEach((item, k) => { rows[item.row] = vectors[k]; });
    if (i && i % (BATCH * 100) === 0) log(`  ${i}/${pending.length} units embeddade...`);
  }
  const dimension = rows[0]?.length || prev?.dimension || 0;
  mkdirSync(dir, { recursive: true });
  const flat = new Float32Array(rows.length * dimension);
  rows.forEach((row, i) => flat.set(row, i * dimension));
  // Readers (CLI, daemon) load meta then vectors; write vectors first and
  // swap each file atomically so a reader never pairs new meta with old rows
  // of a different length.
  writeFileSync(join(dir, "vectors.bin.tmp"), Buffer.from(flat.buffer));
  writeFileSync(join(dir, "meta.json.tmp"), JSON.stringify({ schemaVersion: SCHEMA_VERSION, builtAt: new Date().toISOString(),
    model: model.name, dimension, complete: deferred === 0, files: meta }));
  renameSync(join(dir, "vectors.bin.tmp"), join(dir, "vectors.bin"));
  renameSync(join(dir, "meta.json.tmp"), join(dir, "meta.json"));
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  log(`Index klart: ${meta.length} filer, ${rows.length} units (${pending.length} nya, ${reused} återanvända`
    + `${deferred ? `, ${deferred} filer väntar till nästa körning` : ""}), ${seconds}s, modell ${model.name}.`);
  return { files: meta.length, chunks: rows.length, embedded: pending.length, reused, deferred, seconds };
}

/** WHAT: Loads the unit index once for repeated queries. WHY: Keeps the daemon from re-reading the vectors per query. */
export function openIndex(dir = indexDir()) {
  const index = loadIndex(dir);
  if (!index || index.schemaVersion !== SCHEMA_VERSION) return null;
  const units = [];
  for (const file of index.meta) {
    for (const unit of file.units) units.push({ file, unit });
  }
  return { ...index, units };
}

/** WHAT: Returns the top-k units by cosine similarity. WHY: Keeps semantic hits in the same unit space as passages for fusion. */
export function rankUnits(index, queryVector, { k = 30, overlay = new Map() } = {}) {
  const dim = index.dimension;
  const top = [];
  const consider = (file, unit, vectors, offset) => {
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += queryVector[i] * vectors[offset + i];
    if (top.length < k || dot > top[top.length - 1].sim) {
      top.push({ file, unit, sim: dot });
      top.sort((a, b) => b.sim - a.sim);
      if (top.length > k) top.pop();
    }
  };
  // Files re-embedded since the index was built are scored from the overlay.
  for (let row = 0; row < index.units.length; row++) {
    const { file, unit } = index.units[row];
    if (!overlay.has(file.file)) consider(file, unit, index.vectors, row * dim);
  }
  for (const entry of overlay.values()) {
    entry.units.forEach((unit, i) => consider(entry, unit, entry.vectors, i * dim));
  }
  return top.map(({ file, unit, sim }) => ({ path: file.file, line: unit.line, root: file.root, weight: file.weight,
    date: dateFromPath(file.file), layer: "sem", sim: Number(sim.toFixed(4)), unit: { line: unit.line, start: unit.start,
      length: unit.length, section: unit.section }, indexedMtimeMs: file.mtimeMs, indexedSize: file.size }));
}
