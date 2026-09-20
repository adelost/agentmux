import { basename } from "node:path";
import { createHash } from "node:crypto";
import { dateFromPath, execRg } from "./search.mjs";
import { chunkMarkdown } from "./search-semantic.mjs";
import { readTopicFile } from "./memory-topics.mjs";

const SOURCE_MAX_BYTES = 1024 * 1024;
const STOP = new Set("a an and are as att av blev blir de den det do du då eller en ett får för från ha hade han har hela hur i in inte jag kan man med mig min mina mitt och of om on på sig ska som the till to vad var vi vilken vilket vilka varför är efter before is it does have when where why who när bara skulle".split(" "));
const ENDINGS = ["arna", "erna", "orna", "ande", "ens", "ets", "ing", "en", "et", "ar", "er", "or", "na", "as", "s"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function stem(word) {
  const ending = ENDINGS.find(value => word.endsWith(value) && word.length - value.length >= 5);
  return ending ? word.slice(0, -ending.length) : word;
}

function terms(text) {
  return (String(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(word => word.length > 1 && !STOP.has(word)).map(stem);
}

function queryForms(tokens) {
  const forms = new Map();
  tokens.forEach((token, index) => {
    for (const word of [token, ...ENDINGS.map(ending => token + ending)]) {
      if (stem(word) === token) forms.set(word, index);
    }
  });
  return forms;
}

function observeWords(text, forms, count) {
  const counts = Array(count).fill(0);
  let length = 0;
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []) {
    if (word.length < 2 || STOP.has(word)) continue;
    length++;
    const index = forms.get(word);
    if (index !== undefined) counts[index]++;
  }
  return { counts, length };
}

function sourceFiles(root) {
  const args = ["--files", "--hidden", "--no-ignore", "-g", root.glob || "*.md"];
  for (const pattern of [...(root.exclude || []), ...(root.semanticExclude || [])]) args.push("-g", `!${pattern}`);
  args.push(root.path);
  return execRg(args).split("\n").filter(path => path.endsWith(".md"));
}

function documentPassages(path, root, tokens, forms) {
  const bytes = readTopicFile(path, SOURCE_MAX_BYTES);
  const text = bytes.toString("utf8");
  const title = text.match(/^# .+$/mu)?.[0] || basename(path);
  const digest = hash(bytes);
  let offset = 0;
  let section = "";
  return chunkMarkdown(text).map(chunk => {
    const start = text.indexOf(chunk.text, offset);
    if (start < 0) throw new Error("passage is not present in its source");
    // Track heading context without repeatedly splitting the entire prefix.
    const prior = text.slice(offset, start);
    section = [...prior.matchAll(/^#{1,4} .+$/gmu)].at(-1)?.[0] || section;
    section = chunk.text.match(/^#{1,4} .+$/mu)?.[0] || section;
    offset = start + chunk.text.length;
    const labels = observeWords(`${basename(path, ".md").replace(/-/gu, " ")} ${title} ${section}`, forms, tokens.length);
    const { counts, length } = observeWords(chunk.text, forms, tokens.length);
    return { path, line: chunk.line, root: root.name, weight: root.weight, date: dateFromPath(path),
      text: chunk.text, counts, labelMatches: labels.counts.map(Boolean), length,
      passage: { sha256: digest, start, length: chunk.text.length } };
  });
}

/** WHAT: Returns source-bound paragraphs ranked for natural questions. WHY: Prevents file-level word-AND from hiding answers behind incidental question words. */
export function searchPassages(query, roots, { max = 12, excludePath = () => false, onWarning = console.warn } = {}) {
  const tokens = [...new Set(terms(query))];
  if (!tokens.length) return [];
  const forms = queryForms(tokens);
  const docs = [];
  const seen = new Set();
  for (const root of roots.filter(root => root.semantic)) {
    for (const path of sourceFiles(root)) {
      if (seen.has(path) || excludePath(path)) continue;
      seen.add(path);
      try { docs.push(...documentPassages(path, root, tokens, forms)); }
      catch (error) { onWarning(`Passage source omitted: ${path} (${error.code || error.message}); original search remains available.`); }
    }
  }
  if (!docs.length) return [];
  const average = docs.reduce((n, doc) => n + doc.length, 0) / docs.length;
  const frequency = tokens.map((_, i) => docs.filter(doc => doc.counts[i] || doc.labelMatches[i]).length);
  return docs.map(doc => {
    let score = 0, matches = 0;
    for (let i = 0; i < tokens.length; i++) {
      const count = doc.counts[i];
      if (!count && !doc.labelMatches[i]) continue;
      matches++;
      const idf = Math.log(1 + (docs.length - frequency[i] + 0.5) / (frequency[i] + 0.5));
      score += idf * (count * 2.2 / (count + 1.2 * (0.25 + 0.75 * doc.length / average))
        + Number(doc.labelMatches[i]));
    }
    return { path: doc.path, line: doc.line, root: doc.root, weight: doc.weight, date: doc.date,
      snippet: doc.text.replace(/\s+/gu, " ").slice(0, 160), passage: doc.passage, layer: "passage", score, matches };
  }).filter(hit => hit.matches >= Math.min(2, tokens.length) && hit.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line).slice(0, max);
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

/** WHAT: Reads a selected paragraph from its verified source version. WHY: Prevents stale search positions from presenting different content after an edit. */
export function expandPassage(hit) {
  try {
    const { sha256, start, length } = hit.passage || {};
    if (!/^[a-f0-9]{64}$/u.test(sha256 || "") || !Number.isSafeInteger(start) || start < 0
      || !Number.isSafeInteger(length) || length < 1 || length > 2400) throw new Error("invalid passage reference");
    const bytes = readTopicFile(hit.path, SOURCE_MAX_BYTES);
    if (hash(bytes) !== sha256) return "Source changed since search; repeat the search before using this passage.";
    const text = bytes.toString("utf8");
    if (start + length > text.length) throw new Error("invalid passage range");
    return `[original passage; source SHA256 ${sha256}]\n${text.slice(start, start + length)}\n[end of excerpt; full source remains available]`;
  } catch (error) { return `Passage unavailable: ${error.code || error.message}; repeat the search.`; }
}
