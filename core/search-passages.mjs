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
const COMPOUND_HEAD = 6;
const DATED_PASSAGES_PER_FILE = 8;
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

// Versions and code identifiers ("1.25.131", "e5-small", "GRACE_S") are also
// kept whole: their parts ("25", "131", "s") match countless unrelated notes.
const IDENTIFIER = /[\p{L}\p{N}]+(?:[._-][\p{L}\p{N}]+)*/gu;
const WORD = /[\p{L}\p{N}]+/gu;

// "Cut kit", "cut-kit" and "cutkit" are one name in Swedish notes: two
// adjacent words separated by one space or hyphen also yield their joined
// form, on both the note and the question side.
function joinedPairs(lower) {
  const joined = [];
  let previous = null;
  for (const match of lower.matchAll(WORD)) {
    const word = match[0];
    if (previous && /^[ -]$/u.test(lower.slice(previous.end, match.index)) && /^\p{L}{2,}$/u.test(previous.word)
      && /^\p{L}{2,}$/u.test(word) && previous.word.length + word.length <= 30) joined.push(previous.word + word);
    previous = { word, end: match.index + word.length };
  }
  return joined;
}

/** Words count toward a unit's length; identifiers and joined pairs are extra spellings of the same words. */
function tokensOf(text) {
  const lower = String(text).toLowerCase();
  const words = lower.match(WORD) || [];
  const identifiers = (lower.match(IDENTIFIER) || []).filter(token => /[._-]/u.test(token) && /[\p{N}_]/u.test(token));
  return { words, extras: [...identifiers, ...joinedPairs(lower)] };
}

// A proper name is matched as written (and in the genitive), never stemmed:
// Snowball reduces "Elina" to "elin", which made Elina's entry lose to Elin's
// file (golden s29). A name is a capitalised word in the question or a word
// of a person's name in the people notes.
const NAME = "=";
const PEOPLE_FILE = /(?:^|\/)people(?:\/[^/]+|)\.md$|\/people\/[^/]+\.md$/u;
const CAPITALISED = /^\p{Lu}\p{Ll}/u;

function terms(text, names = new Set()) {
  const original = String(text).match(WORD) || [];
  const capitalised = new Set(original.filter(word => CAPITALISED.test(word)).map(word => word.toLowerCase()));
  const { words, extras } = tokensOf(text);
  return [...words, ...extras].filter(word => word.length > 1 && !STOP.has(word))
    .map(word => (/[._-]/u.test(word) ? word : capitalised.has(word) || names.has(word) ? NAME + word : stem(word)));
}

// Snowball only strips suffixes, so a word can share a query stem only when it
// starts with that stem. Checking the prefix first keeps stemming off the hot
// path for the millions of words that cannot match.
function stemIndex(word, stems) {
  if (/[._-]/u.test(word)) return stems.get(word);
  for (const [value, index] of stems) {
    if (value.startsWith(NAME)) {
      const name = value.slice(1);
      if (word === name || word === `${name}s` || `${word}s` === name) return index;
      continue;
    }
    if (word.startsWith(value) && stem(word) === value) return index;
  }
  // A Swedish compound starting with a long question word is about it:
  // "fallskärm" in the question, "fallskärmshoppning" in the note.
  for (const [value, index] of stems) {
    if (!value.startsWith(NAME) && value.length >= COMPOUND_HEAD && word.length >= value.length + 3 && word.startsWith(value)) return index;
  }
  return undefined;
}

function lowerBound(sorted, value) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function wordsWithPrefixes(sorted, prefixes) {
  const found = new Set();
  for (const prefix of prefixes) {
    for (let index = lowerBound(sorted, prefix); index < sorted.length && sorted[index].startsWith(prefix); index++) found.add(sorted[index]);
  }
  return [...found];
}

function wordsOf(text) {
  const tf = new Map();
  let length = 0;
  const { words, extras } = tokensOf(text);
  for (const word of words) {
    if (word.length < 2 || STOP.has(word)) continue;
    length++;
    tf.set(word, (tf.get(word) || 0) + 1);
  }
  for (const word of extras) if (!STOP.has(word)) tf.set(word, (tf.get(word) || 0) + 1);
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
    // The term a unit defines ("**Julia** — bekant via Hinge") is its subject,
    // so it counts like a heading: a note that merely mentions the name ranks
    // below the entry that says who the person is.
    const labels = new Set(wordsOf(`${name} ${title} ${context.join(" ")} ${unit.defines || ""}`).tf.keys());
    for (const word of body.tf.keys()) vocabulary.add(word);
    for (const word of labels) vocabulary.add(word);
    totalLength += body.length;
    return { line: unit.line, start: unit.start, length: unit.length, section: unit.section, context,
      snippet: unit.text.replace(/\s+/gu, " ").slice(0, 160), tf: body.tf, words: body.length, labels, defines: unit.defines };
  });
  const names = new Set();
  if (PEOPLE_FILE.test(path)) {
    for (const value of [basename(path, ".md"), ...units.map(unit => unit.defines)]) {
      for (const word of String(value || "").toLowerCase().match(WORD) || []) if (word.length >= 3 && !/\d/u.test(word)) names.add(word);
    }
  }
  // Sorted once per file version: every query term matches words that start
  // with it, so a binary search finds them instead of scanning the file's
  // whole vocabulary (that scan was ~0.7 s of every query over 39k units).
  const sortedVocabulary = [...vocabulary].sort();
  return { sha256: hash(bytes), date: dateFromPath(path), units, vocabulary, sortedVocabulary, totalLength, names };
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
export function searchPassages(query, roots, { max = 12, excludePath = () => false, onWarning = console.warn, cache = null, dates = [],
  perFile = PASSAGES_PER_FILE } = {}) {
  const files = [];
  const seen = new Set();
  for (const root of roots.filter(root => root.semantic)) {
    for (const path of sourceFiles(root)) {
      if (seen.has(path) || excludePath(path)) continue;
      seen.add(path);
      files.push({ path, root });
    }
  }
  const segments = new Map();
  const segmentOf = (path) => {
    if (!segments.has(path)) {
      try { segments.set(path, cachedSegment(path, cache)); }
      catch (error) { segments.set(path, null); onWarning(`Passage source omitted: ${path} (${error.code || error.message}); original search remains available.`); }
    }
    return segments.get(path);
  };
  const names = new Set();
  for (const { path } of files) if (PEOPLE_FILE.test(path)) for (const name of segmentOf(path)?.names || []) names.add(name);
  const tokens = [...new Set(terms(query, names))];
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
  // A term can only match words that start with it (stems, compound heads,
  // identifiers) or, for a genitive name, with the name less its "s".
  const prefixes = [...new Set(tokens.flatMap(token => {
    if (!token.startsWith(NAME)) return [token];
    const name = token.slice(NAME.length);
    return name.endsWith("s") ? [name, name.slice(0, -1)] : [name];
  }))];
  const docs = [];
  let unitCount = 0;
  let totalLength = 0;
  for (const { path, root } of files) {
    const segment = segmentOf(path);
    if (!segment) continue;
    unitCount += segment.units.length;
    totalLength += segment.totalLength;
    const matching = wordsWithPrefixes(segment.sortedVocabulary, prefixes).filter(word => termOf(word) >= 0);
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
  if (!docs.length) return [];
  const average = totalLength / Math.max(1, unitCount);
  const frequency = tokens.map((_, i) => docs.filter(doc => doc.counts[i] || doc.labelMatches[i]).length);
  const idfs = frequency.map(f => Math.log(1 + (unitCount - f + 0.5) / (f + 0.5)));
  const idfTotal = idfs.reduce((sum, value) => sum + value, 0) || 1;
  const ranked = docs.map(({ path, root, segment, unit, counts, labelMatches }) => {
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
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  if (!dates.length) return ranked.filter(topPassagesPerFile(perFile)).slice(0, max);
  // A question about "i går" is about that day's note, which holds dozens of
  // units; the usual two-per-file cap would hide most of them.
  const wanted = new Set(dates);
  const dated = ranked.filter(hit => wanted.has(hit.date)).filter(topPassagesPerFile(DATED_PASSAGES_PER_FILE)).slice(0, max);
  const rest = ranked.filter(hit => !wanted.has(hit.date)).filter(topPassagesPerFile(perFile)).slice(0, Math.max(0, max - dated.length));
  return [...dated, ...rest];
}

const PHRASE_UNITS_PER_FILE = 2;
const DECISION_WORDS = /\b(?:BESLUT|[Bb]eslut|bestämt|bestämde|valde|decision|decided|ska vara|gäller)\b/u;

/**
 * WHAT: Returns the units of one file that contain an exact phrase, densest first.
 * WHY: Keeps an exact hit from opening the first passing mention instead of the unit about the phrase.
 */
export function phraseUnits(hit, pattern, { limit = PHRASE_UNITS_PER_FILE } = {}) {
  const bytes = readTopicFile(hit.path, SOURCE_MAX_BYTES);
  const text = bytes.toString("utf8");
  const sha256 = hash(bytes);
  const units = markdownUnits(text).map(unit => {
    const occurrences = (unit.text.match(new RegExp(pattern.source, "giu")) || []).length;
    // A unit that names the term in its heading or bold lead, or records a
    // decision about it, defines it more than one that mentions it in passing.
    const named = [...unit.headings, unit.entry, unit.defines].some(label => label && pattern.test(label));
    const decides = DECISION_WORDS.test(unit.text);
    const density = occurrences / Math.max(1, unit.text.length);
    return { unit, density, about: density * (1 + Number(named) + Number(decides)) };
  }).filter(({ density }) => density > 0);
  // "Respiten är 600 s (GRACE_S)" is about the term; a 1600-character status
  // bullet that names it once in passing is not (golden dev n31).
  units.sort((a, b) => b.about - a.about || a.unit.start - b.unit.start);
  return units.slice(0, limit).map(({ unit, about }) => ({ ...hit, line: unit.line, dedupeKey: `${hit.path}#${unit.start}`, about,
    snippet: unit.text.replace(/\s+/gu, " ").slice(0, 160),
    passage: { sha256, start: unit.start, length: unit.length, context: [...unit.headings, ...(unit.entry ? [unit.entry] : [])], section: unit.section } }));
}

// A daily file's second section can still be the answer (golden eval: one
// per file lost answers, two kept them).
/**
 * WHAT: Filters ranked items to the best few of each file.
 * WHY: Prevents one long note from filling the overview with its neighbours.
 */
export function topPassagesPerFile(limit = PASSAGES_PER_FILE) {
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
