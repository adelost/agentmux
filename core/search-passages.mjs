import { basename } from "node:path";
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { dateFromPath, execRg } from "./search.mjs";
import { markdownUnits } from "./search-units.mjs";
import { readTopicFile } from "./memory-topics.mjs";
import { swedishStem } from "./swedish-stem.mjs";

const SOURCE_MAX_BYTES = 1024 * 1024;
const STOP = new Set("a an and are as att av blev blir de den det do du då eller en ett får för från ha hade han har hela hur i in inte jag kan man med mig min mina mitt och of om on på sig ska som the till to vad var vi vilken vilket vilka varför är efter before is it does have when where why who när bara skulle".split(" "));
const PASSAGES_PER_FILE = 2;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const stemCache = new Map();

function stem(word) {
  let value = stemCache.get(word);
  if (value === undefined) {
    value = swedishStem(word);
    if (stemCache.size > 200_000) stemCache.clear();
    stemCache.set(word, value);
  }
  return value;
}

// Versions, hashes and dotted names ("1.25.131", "e5-small") are also kept
// whole: their parts ("25", "131") match countless unrelated notes.
const IDENTIFIER = /[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu;
const WORD = /[\p{L}\p{N}]+/gu;

function tokensOf(text) {
  const lower = String(text).toLowerCase();
  const words = lower.match(WORD) || [];
  const identifiers = (lower.match(IDENTIFIER) || []).filter(token => /[._-]/u.test(token) && /\p{N}/u.test(token));
  return [...words, ...identifiers];
}

function terms(text) {
  return tokensOf(text).filter(word => word.length > 1 && !STOP.has(word))
    .map(word => (/[._-]/u.test(word) ? word : stem(word)));
}

// Snowball only strips suffixes, so a word can share a query stem only when it
// starts with that stem. Checking the prefix first keeps stemming off the hot
// path for the millions of words that cannot match.
function stemIndex(word, stems) {
  if (/[._-]/u.test(word)) return stems.get(word);
  for (const [value, index] of stems) {
    if (word.startsWith(value) && stem(word) === value) return index;
  }
  return undefined;
}

function wordsOf(text) {
  const tf = new Map();
  let length = 0;
  for (const word of tokensOf(text)) {
    if (word.length < 2 || STOP.has(word)) continue;
    if (!/[._-]/u.test(word)) length++;
    tf.set(word, (tf.get(word) || 0) + 1);
  }
  return { tf, length };
}

function sourceFiles(root) {
  const args = ["--files", "--hidden", "--no-ignore", "-g", root.glob || "*.md"];
  for (const pattern of [...(root.exclude || []), ...(root.semanticExclude || [])]) args.push("-g", `!${pattern}`);
  args.push(root.path);
  return execRg(args).split("\n").filter(path => path.endsWith(".md"));
}

/**
 * WHAT: Parses one file into units with their word counts, independent of
 * any query.
 * WHY: A long-lived process (the search daemon) reuses it for every query
 * while the file is unchanged; only scoring is per query.
 */
function fileSegment(path) {
  const bytes = readTopicFile(path, SOURCE_MAX_BYTES);
  const text = bytes.toString("utf8");
  const title = text.match(/^# .+$/mu)?.[0] || basename(path);
  const name = basename(path, ".md").replace(/-/gu, " ");
  const vocabulary = new Set();
  let totalLength = 0;
  const units = markdownUnits(text).map(unit => {
    const context = [...unit.headings, ...(unit.entry ? [unit.entry] : []), ...(unit.tableHeader ? [unit.tableHeader] : [])];
    const body = wordsOf(unit.text);
    const labels = new Set(wordsOf(`${name} ${title} ${context.join(" ")}`).tf.keys());
    for (const word of body.tf.keys()) vocabulary.add(word);
    for (const word of labels) vocabulary.add(word);
    totalLength += body.length;
    return { line: unit.line, start: unit.start, length: unit.length, section: unit.section, context,
      snippet: unit.text.replace(/\s+/gu, " ").slice(0, 160), tf: body.tf, words: body.length, labels };
  });
  return { sha256: hash(bytes), date: dateFromPath(path), units, vocabulary, totalLength };
}

/** WHAT: Returns a file's segment, rebuilt only when it changed. WHY: Keeps repeated queries in one process from re-reading the corpus. */
function cachedSegment(path, cache) {
  const info = statSync(path);
  const hit = cache?.get(path);
  if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.segment;
  const segment = fileSegment(path);
  cache?.set(path, { mtimeMs: info.mtimeMs, size: info.size, segment });
  return segment;
}

/** WHAT: Returns source-bound note items ranked for natural questions. WHY: Prevents file-level word-AND from hiding answers behind incidental question words. */
export function searchPassages(query, roots, { max = 12, excludePath = () => false, onWarning = console.warn, cache = null } = {}) {
  const tokens = [...new Set(terms(query))];
  if (!tokens.length) return [];
  const stems = new Map(tokens.map((token, index) => [token, index]));
  const matchOf = new Map();
  const termOf = (word) => {
    let value = matchOf.get(word);
    if (value === undefined) {
      value = stemIndex(word, stems) ?? -1;
      matchOf.set(word, value);
    }
    return value;
  };
  const docs = [];
  const seen = new Set();
  let unitCount = 0;
  let totalLength = 0;
  for (const root of roots.filter(root => root.semantic)) {
    for (const path of sourceFiles(root)) {
      if (seen.has(path) || excludePath(path)) continue;
      seen.add(path);
      let segment;
      try { segment = cachedSegment(path, cache); }
      catch (error) { onWarning(`Passage source omitted: ${path} (${error.code || error.message}); original search remains available.`); continue; }
      unitCount += segment.units.length;
      totalLength += segment.totalLength;
      const matching = [...segment.vocabulary].filter(word => termOf(word) >= 0);
      if (!matching.length) continue;
      for (const unit of segment.units) {
        const counts = Array(tokens.length).fill(0);
        const labelMatches = Array(tokens.length).fill(false);
        let any = false;
        for (const word of matching) {
          const term = matchOf.get(word);
          const count = unit.tf.get(word);
          if (count) { counts[term] += count; any = true; }
          if (unit.labels.has(word)) { labelMatches[term] = true; any = true; }
        }
        if (any) docs.push({ path, root, segment, unit, counts, labelMatches });
      }
    }
  }
  if (!docs.length) return [];
  const average = totalLength / Math.max(1, unitCount);
  const frequency = tokens.map((_, i) => docs.filter(doc => doc.counts[i] || doc.labelMatches[i]).length);
  const idfs = frequency.map(f => Math.log(1 + (unitCount - f + 0.5) / (f + 0.5)));
  const idfTotal = idfs.reduce((sum, value) => sum + value, 0) || 1;
  return docs.map(({ path, root, segment, unit, counts, labelMatches }) => {
    let score = 0, matches = 0, covered = 0;
    for (let i = 0; i < tokens.length; i++) {
      const count = counts[i];
      if (!count && !labelMatches[i]) continue;
      matches++;
      covered += idfs[i];
      score += idfs[i] * (count * 2.2 / (count + 1.2 * (0.25 + 0.75 * unit.words / average))
        + Number(labelMatches[i]));
    }
    // Weight by how much of the question's rare vocabulary the unit covers.
    // A hard "two words must match" rule hid answers that share only the
    // decisive word with the question ("hur gammal är Axel" → "**Axel** —
    // systerson, 1.5 år"), while a common word alone still scores near zero.
    score *= covered / idfTotal;
    return { path, line: unit.line, root: root.name, weight: root.weight, date: segment.date, snippet: unit.snippet,
      passage: { sha256: segment.sha256, start: unit.start, length: unit.length, context: unit.context, section: unit.section },
      layer: "passage", score, matches };
  }).filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line)
    .filter(topPassagesPerFile()).slice(0, max);
}

/**
 * WHAT: Keeps the two best-ranked paragraphs of each file.
 * WHY: Prevents one long note from filling the overview with its neighbours,
 * while a daily file's second section can still be the answer (golden eval:
 * one per file lost answers, two kept them).
 */
function topPassagesPerFile(limit = PASSAGES_PER_FILE) {
  const seen = new Map();
  return hit => {
    const count = seen.get(hit.path) || 0;
    seen.set(hit.path, count + 1);
    return count < limit;
  };
}

/** WHAT: Returns paragraphs alongside original search evidence. WHY: Keeps exact receipts ahead of approximate matches without discarding the remaining history. */
export function mergePassageHits(original, passages) {
  const ordered = [...original.filter(hit => hit.layer === "L1"), ...passages.slice(0, 3),
    ...original.filter(hit => hit.layer !== "L1"), ...passages.slice(3)];
  const seen = new Set();
  return ordered.filter(hit => {
    const key = `${hit.path}:${hit.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const CONTEXT_CHARS = 2400;

// A bullet is retrieved alone for precision, but its meaning often depends
// on the neighbouring bullets and the heading it sits under.
/**
 * WHAT: Returns the section span around a passage, or a centred window.
 * WHY: Keeps an expanded bullet from losing its heading and neighbours.
 */
export function passageContextRange(text, { start, length, section }) {
  let from = start;
  let to = start + length;
  if (section && Number.isSafeInteger(section.start) && Number.isSafeInteger(section.end)
    && section.start <= start && section.end >= to && section.end <= text.length) {
    from = section.start;
    to = section.end;
    if (to - from > CONTEXT_CHARS) {
      const spare = Math.max(0, CONTEXT_CHARS - length);
      from = Math.max(section.start, start - Math.floor(spare / 2));
      to = Math.min(section.end, start + length + Math.ceil(spare / 2));
      if (from > section.start) from = text.indexOf("\n", from - 1) + 1 || start;
      if (from > start) from = start;
      const lineEnd = text.lastIndexOf("\n", to);
      if (to < section.end && lineEnd >= start + length) to = lineEnd;
    }
  }
  return { from, to };
}

/** WHAT: Reads a selected passage and its section from the verified source version. WHY: Prevents stale search positions from presenting different content after an edit. */
export function expandPassage(hit) {
  try {
    const { sha256, start, length } = hit.passage || {};
    if (!/^[a-f0-9]{64}$/u.test(sha256 || "") || !Number.isSafeInteger(start) || start < 0
      || !Number.isSafeInteger(length) || length < 1 || length > CONTEXT_CHARS) throw new Error("invalid passage reference");
    const bytes = readTopicFile(hit.path, SOURCE_MAX_BYTES);
    if (hash(bytes) !== sha256) return "Source changed since search; repeat the search before using this passage.";
    const text = bytes.toString("utf8");
    if (start + length > text.length) throw new Error("invalid passage range");
    const { from, to } = passageContextRange(text, hit.passage);
    const before = text.slice(from, start);
    const after = text.slice(start + length, to);
    return `[original passage in its section; source SHA256 ${sha256}]\n${before}${text.slice(start, start + length)}${after}\n[end of excerpt; full source remains available]`;
  } catch (error) { return `Passage unavailable: ${error.code || error.message}; repeat the search.`; }
}
