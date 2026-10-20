/**
 * WHAT: Checks the text of rule files: his protected words, layer repeats, CLAUDE.md shape and rotting claims.
 * WHY: Keeps the prose checks free of git and settings so each runs on plain strings.
 */

const QUOTES = [
  /"([^"]+)"/g, /“([^”]+)”/g, /„([^“”]+)[“”]/g,
  /”([^”]+)”/g, /«([^»]+)»/g, /»([^«]+)«/g,
];
const DATE = /\b\d{4}-\d{2}-\d{2}\b/;
const COUNT = /\(\d+ lines\)|\b\d+ (?:[\w-]+ )?(?:handlers|tests|components|files|commands)\b/g;
const STATUS = /not deployed|switched off|waits for/i;
const SIZE_LIMIT = 30 * 1024;
const RUN_WORDS = 5;
const SENTENCE_WORDS = 8;
const DUPLICATE_SHARE = 0.6;
const IMPORT = /(?:^|\s)@(?:\.{1,2}\/)*AGENTS\.md\b/;
const LINK_TO_AGENTS = /\[[^\]]*\]\([^)]*AGENTS\.md[^)]*\)/;

const squash = (text) => text.replace(/\s+/g, " ").trim();
const wordsOf = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

function quotesOf(line) {
  const quotes = [];
  for (const pattern of QUOTES) for (const m of line.matchAll(pattern)) if (wordsOf(m[1]).length >= 3) quotes.push(m[1]);
  return quotes;
}

/**
 * WHAT: Checks whether a line holds his words: a quote plus a date or his name.
 * WHY: Keeps his decisions out of every duplicate and removal judgment.
 */
export function isProtectedLine(line) {
  return quotesOf(line).length > 0 && (DATE.test(line) || /\bMattias\b/i.test(line));
}

/**
 * WHAT: Collects the protected lines of one rule file with their 1-based line numbers.
 * WHY: Keeps the owner able to see what the lint will never propose to delete.
 */
export function protectedLines(text) {
  return text.split(/\r?\n/).flatMap((line, index) => (isProtectedLine(line) ? [{ line: index + 1, text: line }] : []));
}

function proseLines(text) {
  let fenced = false;
  return text.split(/\r?\n/).map((line, index) => {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) { fenced = !fenced; return null; }
    return fenced || /^\s*(?:#|\|)/.test(line) ? null : { line: index + 1, text: line };
  }).filter(Boolean);
}

const runsOf = (words) => Array.from({ length: Math.max(0, words.length - RUN_WORDS + 1) }, (_, i) => words.slice(i, i + RUN_WORDS).join(" "));

function indexLayer(layer) {
  const lines = layer.text.split(/\r?\n/).map((text) => new Set(runsOf(wordsOf(text))));
  return { ...layer, lines, all: new Set(lines.flatMap((set) => [...set])) };
}

function bestMatch(runs, layers) {
  let best = null;
  for (const layer of layers) {
    const shared = runs.filter((run) => layer.all.has(run)).length;
    const share = shared / runs.length;
    if (share < DUPLICATE_SHARE || (best && share <= best.share)) continue;
    const layerLine = layer.lines.reduce((top, set, i) => {
      const hits = runs.filter((run) => set.has(run)).length;
      return hits > top.hits ? { hits, line: i + 1 } : top;
    }, { hits: 0, line: 1 }).line;
    best = { share: Math.round(share * 100) / 100, layer: { name: layer.name, label: layer.label }, layerLine };
  }
  return best;
}

/**
 * WHAT: Compares each sentence of a rule file with higher layers by shared five-word runs.
 * WHY: Keeps duplicate candidates as warnings that name the layer line, never as proposals to delete his words.
 */
export function layerDuplicates(text, layers) {
  const indexed = layers.map(indexLayer);
  const found = [];
  for (const { line, text: content } of proseLines(text)) {
    if (isProtectedLine(content)) continue;
    const bare = content.replace(/^\s*(?:[-*+>]|\d+[.)])\s+/, "");
    let top = null;
    for (const sentence of bare.split(/(?<=[.!?])\s+/)) {
      const words = wordsOf(sentence);
      if (words.length < SENTENCE_WORDS) continue;
      const match = bestMatch([...new Set(runsOf(words))], indexed);
      if (match && (!top || match.share > top.share)) top = match;
    }
    if (top) found.push({ line, ...top });
  }
  return found;
}

function removedFrom(block) {
  const [head, ...body] = block.split("\n");
  const [commit, date] = head.split("\u0002");
  const removed = [];
  let oldLine = 0;
  let inHunk = false;
  for (const row of body) {
    const hunk = row.match(/^@@ -(\d+)(?:,\d+)? \+/);
    if (row.startsWith("diff --git")) inHunk = false;
    else if (hunk) { inHunk = true; oldLine = Number(hunk[1]); }
    else if (inHunk && row.startsWith("-")) { removed.push({ line: oldLine, text: row.slice(1) }); oldLine += 1; }
  }
  return { commit, date, removed };
}

/**
 * WHAT: Collects protected lines removed in 90 days whose words are nowhere on trunk.
 * WHY: Keeps a deleted decision of his from vanishing unseen behind a tidy-up commit.
 */
export function removedProtected(git, trunk, file) {
  const log = git(["log", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", "--since=90.days", "--format=%x01%H%x02%as", trunk, "--", file]);
  if (!log.ok || !log.out) return [];
  const current = squash(git(["show", `${trunk}:${file}`]).out || "");
  const present = new Map();
  const survives = (quote) => {
    if (!present.has(quote)) {
      const grep = current.includes(squash(quote)) || (() => {
        const found = git(["grep", "-F", "-q", "-e", quote, trunk]);
        return found.ok || found.code > 1;
      })();
      present.set(quote, grep);
    }
    return present.get(quote);
  };
  const lost = [];
  for (const block of log.out.split("\u0001").slice(1)) {
    const { commit, date, removed } = removedFrom(block);
    const lines = removed.filter((row) => isProtectedLine(row.text) && quotesOf(row.text).some((quote) => !survives(quote))).map((row) => row.line);
    if (lines.length) lost.push({ commit, short: commit.slice(0, 7), date, lines });
  }
  return lost;
}

const bodyLines = (text) => text.split(/\r?\n/).filter((line) => line.trim() && !/^\s*#/.test(line));
const isPointer = (text) => bodyLines(text).length <= 2 && bodyLines(text).some((line) => LINK_TO_AGENTS.test(line));

function importsAgents(text) {
  let fenced = false;
  return text.split(/\r?\n/).some((line) => {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) { fenced = !fenced; return false; }
    return !fenced && IMPORT.test(line);
  });
}

function duplicateShape(claude, agents) {
  if (claude.symlink) return `${claude.file} is a symlink to ${claude.target}, it should be exactly @AGENTS.md`;
  if (squash(claude.text) === squash(agents.text)) return `${claude.file} is a copy of AGENTS.md, it should be exactly @AGENTS.md`;
  if (isPointer(claude.text)) return `${claude.file} only links to AGENTS.md and Claude does not load linked files, it should import it with @AGENTS.md`;
  return null;
}

/**
 * WHAT: Checks how Claude and Codex reach AGENTS.md from CLAUDE.md files and the machine setting.
 * WHY: Prevents a repo whose rules only one engine reads, or neither, from passing as covered.
 */
export function claudeShape({ agents, claudes, setting }) {
  if (!agents) {
    return claudes.length ? [{ tag: "codex", file: claudes[0].file, msg: `${claudes[0].file} is the only rule file, Codex reads none of these rules` }] : [];
  }
  const findings = claudes.flatMap((claude) => {
    const msg = duplicateShape(claude, agents);
    return msg ? [{ tag: "shape", file: claude.file, msg }] : [];
  });
  const loads = claudes.some((c) => c.symlink || importsAgents(c.text) || squash(c.text) === squash(agents.text));
  if (!setting && !loads) {
    findings.push({ tag: "reach", file: agents.file, msg: "Claude does not load AGENTS.md here: the setting is missing and no CLAUDE.md imports it" });
  }
  return findings;
}

/**
 * WHAT: Reports counts that rot, undated status claims and an oversized rule file.
 * WHY: Keeps the cheap prose checks in one place, all warnings, never certain errors.
 */
export function heuristicFindings(text) {
  const findings = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const m of line.matchAll(COUNT)) findings.push({ tag: "count", line: index + 1, msg: `"${m[0]}" is a count that rots` });
    const status = line.match(STATUS);
    if (status && !DATE.test(line)) findings.push({ tag: "status", line: index + 1, msg: `"${status[0]}" is a status claim without a date` });
  });
  const bytes = Buffer.byteLength(text);
  if (bytes > SIZE_LIMIT) findings.push({ tag: "size", line: null, msg: `${Math.round(bytes / 1024)} KB, over the 30 KB a rule file should stay under` });
  return findings;
}

const MAX_DIFF_CELLS = 4_000_000;

function trimmedMiddle(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return { head, a: a.slice(head, a.length - tail), b: b.slice(head, b.length - tail) };
}

/** Walks the longest-common-subsequence table and returns the 0-based indexes of b's lines that a lacks, plus deletion points. */
function changedIndexes(a, b) {
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const changed = [];
  let i = 0;
  let j = 0;
  let added = [];
  let deleted = false;
  const flush = () => {
    if (added.length) changed.push(...added);
    else if (deleted) changed.push(Math.max(0, Math.min(j, b.length - 1)));
    added = []; deleted = false;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      flush(); i += 1; j += 1;
    } else if (j < b.length && (i === a.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
      added.push(j); j += 1;
    } else {
      deleted = true; i += 1;
    }
  }
  flush();
  return [...new Set(changed)];
}

function rangesOf(numbers) {
  const ranges = [];
  for (const n of numbers) {
    const last = ranges[ranges.length - 1];
    if (last && n === last[1] + 1) last[1] = n; else ranges.push([n, n]);
  }
  return ranges.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(", ");
}

/**
 * WHAT: Reports the working-tree lines that differ from the trunk text, as "3, 5-6".
 * WHY: Lets the loaded-file warning point at the lines a pane reads differently without printing them.
 */
export function differingLines(trunkText, workText) {
  const middle = trimmedMiddle(trunkText.split("\n"), workText.split("\n"));
  if (middle.a.length * middle.b.length > MAX_DIFF_CELLS) return `${middle.b.length} lines`;
  const changed = changedIndexes(middle.a, middle.b).map((index) => index + middle.head + 1);
  return rangesOf(changed.sort((x, y) => x - y)) || "trailing whitespace";
}
