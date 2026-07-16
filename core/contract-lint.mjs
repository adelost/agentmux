/**
 * WHAT: Validates WHAT:/WHY: doc contracts and flags AI-fluff in source comments.
 * WHY: Keeps the contract rules in one tested core, away from per-repo CLI wiring.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "path";
import { changedSourceLineNumbers, changedSourcePaths, lintFileSizes, lintStringStyle, loadLintPolicy } from "./lint-ratchet.mjs";

// WHAT: Names the contract check used by CLI include and exclude filters.
// WHY: Keeps command routing independent from the check implementation.
export const CONTRACT_CHECK_ID = "contract";

// WHAT: Filler/meta phrases banned anywhere in a doc block, with a teaching hint.
// WHY: Keeps unambiguous narration out while leaving position-sensitive words alone.
const ALWAYS_BANNED = [
  [/\bit exists as\b/i, "existential filler; name the boundary instead"],
  [/\bit exists to\b/i, "existential filler; name the boundary instead"],
  [/\bthis class\b/i, "don't narrate that it's a class; say what it does"],
  [/\bthis helper\b/i, "don't narrate that it's a helper; say what it does"],
  [/\bprovides a way to\b/i, "filler; state what it does directly"],
  [/\blightweight fallback\b/i, "vague; say what it falls back from"],
  [/\btruthful\b(?!\s+[a-z])/i, "vague predicate; say exactly what stays consistent"],
];

// WHAT: Openers banned only when they START a WHAT/WHY value (or untagged doc).
// WHY: Separates the lazy "Used to X" description from legit mid-sentence "used to".
const LEADING_BANNED = [
  [/^used to\b/i, "filler opener; state the action directly"],
  [/^(?:is )?responsible for\b/i, "meta opener; name the behavior"],
  [/^serves as\b/i, "meta opener; name the behavior"],
  [/^acts as\b/i, "meta opener; name the behavior"],
  [/^(?:a |the )?helper for\b/i, "lazy opener; name the behavior, not 'helper for'"],
];

// WHAT: Vague adjectives banned only when the WHY has no real boundary.
// WHY: Keeps "Keeps migrations simple" legal while flagging a bare "keeps it clean".
const SOFT_ADJECTIVES = ["clean", "simple", "nice", "proper"];

// WHAT: Boundary/causal markers a real WHY uses to name what it prevents.
// WHY: Separates a genuine boundary ("Keeps X from Y") from existential filler.
const BOUNDARY_MARKERS = [
  /\bkeeps?\b/i, /\bseparates?\b/i, /\bavoids?\b/i, /\bprevents?\b/i,
  /\bisolates?\b/i, /\bhides?\b/i, /\blimits?\b/i, /\bpreserves?\b/i,
  /\bdecouples?\b/i, /\bguards?\b/i, /\bstops?\b/i,
  /\bso that\b/i, /\botherwise\b/i, /\bbecause\b/i, /\binstead of\b/i,
  /\bwithout\b/i, /\bindependent\b/i, /\blets?\b/i,
];

// WHAT: Generic words dropped before measuring WHAT/WHY token overlap.
// WHY: Keeps the echo check from firing on shared articles and prepositions.
const STOPWORDS = new Set(
  ("the a an of to for and or in on with from into one that this it its is are be"
    + " when where which by as at so not no after before per each all any out across"
    + " they them their then than over under same other only just more most").split(/\s+/),
);

const WHAT_MAX_WORDS = 16;
const WHY_MAX_WORDS = 18;
const ECHO_OVERLAP_THRESHOLD = 0.5;
const CONTRACT_TAGS = ["WHAT", "WHY", "DTO", "REMOVE", "REFACTOR", "MERGE", "DEPRECATED", "DEBT"];
const DEBT_TAGS = ["REMOVE", "REFACTOR", "MERGE", "DEPRECATED", "DEBT"];

// WHAT: Defines precise active verbs accepted across repositories by default.
// WHY: Keeps contract grammar shared while repo-specific verbs remain configurable.
export const DEFAULT_WHAT_VERBS = [
  "Assigns",
  "Builds",
  "Calculates",
  "Carries",
  "Checks",
  "Collects",
  "Compares",
  "Decodes",
  "Defines",
  "Describes",
  "Dispatches",
  "Encodes",
  "Expands",
  "Extracts",
  "Fetches",
  "Filters",
  "Formats",
  "Indexes",
  "Loads",
  "Lints",
  "Maps",
  "Names",
  "Normalizes",
  "Parses",
  "Reads",
  "Reports",
  "Resolves",
  "Routes",
  "Returns",
  "Saves",
  "Schedules",
  "Stores",
  "Stubs",
  "Tracks",
  "Turns",
  "Wraps",
];

// WHAT: Maps each finding code to a one-line fix template.
// WHY: Lets an agent running the linter see the target WHAT/WHY shape, not just the error.
const SUGGESTIONS = {
  CONTRACT001: "add  WHAT: <verb + responsibility>  and  WHY: Keeps <X> from <Y>",
  CONTRACT010: "add  WHAT: <active verb + local responsibility>",
  CONTRACT011: "add  WHY: Keeps <X> from <Y>  (name the coupling it prevents)",
  CONTRACT020: "drop the phrase; name the boundary it prevents",
  CONTRACT021: "open with a verb (Tracks/Keeps/Filters), not a meta-phrase",
  CONTRACT030: "WHY must name a boundary: Keeps/Separates/Prevents/Avoids <X> from <Y>",
  CONTRACT031: "replace the adjective with the boundary it preserves",
  CONTRACT040: "WHY repeats WHAT; name a consumer, dependency, or failure mode instead",
  CONTRACT041: "fill the DTO: line with the payload/schema shape",
  CONTRACT042: "use WHAT:/WHY: because this symbol owns a domain boundary, not a pure shape",
  CONTRACT043: "choose either DTO: for pure shape OR WHAT:/WHY: for domain boundary, not both",
  CONTRACT050: "resolve the debt, or keep the action tag baselined until that milestone",
  CONTRACT051: "fill the debt tag with concrete evidence + next action",
  CONTRACT052: "prefer REMOVE:/REFACTOR:/MERGE:/DEPRECATED: over generic DEBT:",
  CONTRACT053: "use exactly one contract state: WHAT/WHY, DTO, one debt action, or delete",
  CONTRACT060: "rewrite WHAT to start with an approved active verb, or add the repo-domain verb to .amux-lint.yml",
};

// WHAT: Pulls the text of one known contract tag out of a doc block.
// WHY: Keeps tag parsing identical across languages so rules stay language-agnostic.
function extractTag(doc, tag) {
  const re = new RegExp(`\\b${tag}:\\s*([\\s\\S]*?)(?=\\b(?:${CONTRACT_TAGS.join("|")}):|$)`, "i");
  const m = doc.match(re);
  return m ? m[1].replace(/[*/]+\s*$/g, "").replace(/\s+/g, " ").trim() : null;
}

function hasTag(doc, tag) {
  return new RegExp(`\\b${tag}:`, "i").test(doc);
}

function presentTags(doc, tags) {
  return tags.filter((tag) => hasTag(doc, tag));
}

function debtContracts(doc, label, debtTags = presentTags(doc, DEBT_TAGS), structuralTags = []) {
  const findings = [];
  for (const tag of debtTags) {
    const value = extractTag(doc, tag);
    if (!value) {
      findings.push({ code: "CONTRACT051", sev: "error", msg: `${label}: ${tag}: tag is empty` });
      continue;
    }
    findings.push({ code: "CONTRACT050", sev: "debt", msg: `${label}: ${tag}: ${value}` });
    if (tag === "DEBT" && !/^(?:remove|refactor|merge|deprecat)/i.test(value)) {
      findings.push({ code: "CONTRACT052", sev: "warn", msg: `${label}: generic DEBT should start with remove/refactor/merge/deprecate` });
    }
  }
  if (debtTags.length > 1 || (debtTags.length && structuralTags.length)) {
    const tags = [...structuralTags, ...debtTags].join("/");
    findings.push({ code: "CONTRACT053", sev: "error", msg: `${label}: mixed contract states (${tags})` });
  }
  return findings;
}

// WHAT: Reduces a word to a crude stem so "Assigns" and "assign" compare equal.
// WHY: Lets the echo check catch reworded duplication without a real stemmer.
function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("es")) return w.slice(0, -1);
  if (w.length > 3 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

// WHAT: Turns a sentence into its set of stemmed content words.
// WHY: Separates meaningful overlap from shared filler when comparing WHAT and WHY.
function contentWords(s) {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w))
      .map(stem),
  );
}

// WHAT: Returns the share of WHY content words that also appear in WHAT.
// WHY: Flags a WHY that just rewords WHAT instead of naming a boundary.
function overlapRatio(what, why) {
  const a = contentWords(what);
  const b = contentWords(why);
  if (b.size === 0) return 0;
  let shared = 0;
  for (const w of b) if (a.has(w)) shared += 1;
  return shared / b.size;
}

function wordCount(s) {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function hasBoundaryMarker(text) {
  return BOUNDARY_MARKERS.some((re) => re.test(text));
}

function firstWord(text) {
  return text.trim().match(/^[A-Za-z][A-Za-z0-9_-]*/)?.[0] || "";
}

function allowedWhatVerbs(options = {}) {
  return new Set([...(options.allowedWhatVerbs || DEFAULT_WHAT_VERBS)]);
}

/**
 * WHAT: Checks one doc block against tagged contract and voice rules.
 * WHY: Keeps every language's findings flowing from one deterministic floor.
 */
export function evaluateContract(doc, { name = "", kind = "symbol", allowedWhatVerbs: verbs } = {}) {
  const label = `${kind} ${name}`.trim();
  const grammarOptions = { allowedWhatVerbs: verbs || DEFAULT_WHAT_VERBS };
  if (!doc || !doc.trim()) {
    return [{ code: "CONTRACT001", sev: "error", msg: `${label}: no doc contract` }];
  }

  const findings = [];
  const debtTags = presentTags(doc, DEBT_TAGS);
  const hasWhat = hasTag(doc, "WHAT");
  const hasWhy = hasTag(doc, "WHY");
  const isDto = hasTag(doc, "DTO");
  const debtFindings = debtContracts(doc, label, debtTags, [
    ...(hasWhat || hasWhy ? ["WHAT/WHY"] : []),
    ...(isDto ? ["DTO"] : []),
  ]);
  if (debtFindings.length) return debtFindings;

  if (isDto) {
    const dto = extractTag(doc, "DTO");
    if (!dto) findings.push({ code: "CONTRACT041", sev: "error", msg: `${label}: DTO: tag is empty` });
    if (hasWhat || hasWhy) findings.push({ code: "CONTRACT043", sev: "error", msg: `${label}: DTO: mixed with WHAT:/WHY:` });
    return findings; // pure transport shapes need only the DTO: line
  }

  const what = extractTag(doc, "WHAT");
  const why = extractTag(doc, "WHY");
  if (!what) findings.push({ code: "CONTRACT010", sev: "error", msg: `${label}: missing WHAT: tag` });
  if (!why) findings.push({ code: "CONTRACT011", sev: "error", msg: `${label}: missing WHY: tag` });

  // Voice checks run on whatever text exists (fallback to whole doc when untagged),
  // so prose-only files still surface fluff, not just missing-tag noise.
  for (const [re, hint] of ALWAYS_BANNED) {
    const m = doc.match(re);
    if (m) findings.push({ code: "CONTRACT020", sev: "error", msg: `${label}: banned phrase "${m[0].trim()}"; ${hint}` });
  }
  const leadTargets = [what, why].filter(Boolean);
  if (leadTargets.length === 0) leadTargets.push(doc.replace(/^[\s*/]+/, ""));
  for (const [re, hint] of LEADING_BANNED) {
    for (const t of leadTargets) {
      const m = t.trim().match(re);
      if (m) { findings.push({ code: "CONTRACT021", sev: "error", msg: `${label}: contract opens with "${m[0].trim()}"; ${hint}` }); break; }
    }
  }

  // Boundary is only meaningful when a WHY exists. A missing WHY is already
  // CONTRACT011 — re-flagging "WHY lacks a boundary" would just double the noise.
  const boundary = why ? hasBoundaryMarker(why) : true;
  if (what) {
    const verb = firstWord(what);
    if (verb && !allowedWhatVerbs(grammarOptions).has(verb)) {
      findings.push({ code: "CONTRACT060", sev: "warn", msg: `${label}: WHAT starts with unknown verb "${verb}"` });
    }
  }
  if (why && !boundary) {
    findings.push({ code: "CONTRACT030", sev: "error", msg: `${label}: WHY lacks a boundary marker (keeps/separates/avoids/prevents/...)` });
    for (const adj of SOFT_ADJECTIVES) {
      if (new RegExp(`\\b${adj}\\b`, "i").test(why)) {
        findings.push({ code: "CONTRACT031", sev: "warn", msg: `${label}: vague adjective "${adj}" with no boundary` });
      }
    }
  }

  if (what && why) {
    if (wordCount(what) > WHAT_MAX_WORDS) findings.push({ code: "CONTRACT012", sev: "warn", msg: `${label}: WHAT is ${wordCount(what)} words (>${WHAT_MAX_WORDS})` });
    if (wordCount(why) > WHY_MAX_WORDS) findings.push({ code: "CONTRACT013", sev: "warn", msg: `${label}: WHY is ${wordCount(why)} words (>${WHY_MAX_WORDS})` });
    if (!boundary && overlapRatio(what, why) >= ECHO_OVERLAP_THRESHOLD) {
      const pct = Math.round(overlapRatio(what, why) * 100);
      findings.push({ code: "CONTRACT040", sev: "warn", msg: `${label}: WHY repeats WHAT (${pct}% overlap, no boundary)` });
    }
  }
  return findings;
}

// ---- Extraction (lexical v1; tree-sitter is a later robustness pass) ----

const SKIP_DIRS = new Set([
  "node_modules", "build", "dist", ".git", ".gradle", ".venv", "venv",
  "__pycache__", ".svelte-kit", "target", "out", ".idea", "generated",
  ".mypy_cache", ".pytest_cache", ".ruff_cache", ".wrangler", "coverage", "fixtures",
  "test", "tests", "__tests__",
]);

const LANG_BY_EXT = {
  ".py": "python",
  ".js": "cfamily", ".mjs": "cfamily", ".ts": "cfamily", ".svelte": "cfamily",
  ".kt": "cfamily", ".kts": "cfamily",
  ".cpp": "cfamily", ".cc": "cfamily", ".cxx": "cfamily", ".hpp": "cfamily", ".h": "cfamily",
};

// WHAT: Names the file extensions the linter knows how to extract symbols from.
// WHY: Keeps directory walks from parsing assets the rules can't reason about.
export const SOURCE_EXTS = Object.keys(LANG_BY_EXT);

const CFAMILY_DECL = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|internal\s+|private\s+|abstract\s+|open\s+|sealed\s+|final\s+|data\s+|inner\s+|enum\s+)*class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:public\s+|internal\s+|private\s+|abstract\s+)*(?:object|interface)\s+([A-Za-z_$][\w$]*)/,
  /^\s*companion\s+object\b/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:public\s+|internal\s+|private\s+|inline\s+|suspend\s+|open\s+|override\s+)*fun\s+(?:<[^>]+>\s+)?([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:struct)\s+([A-Za-z_$][\w$]*)\b(?![^{]*;)/,
  /^\s*export\s+const\s+([A-Za-z_$][\w$]*)\s*=/,
];

// WHAT: Grabs the comment block immediately above a C-family declaration line.
// WHY: Keeps KDoc/JSDoc/Doxygen association in one place for every brace language.
function leadingComment(lines, declIndex) {
  const out = [];
  let i = declIndex - 1;
  // skip annotations/decorators directly above the declaration
  while (i >= 0 && /^\s*[@]/.test(lines[i])) i -= 1;
  if (i < 0) return "";
  const raw = lines[i].trim();
  if (raw.endsWith("*/")) {
    const block = [];
    let j = i;
    while (j >= 0) {
      const l = lines[j].trim();
      block.push(l.replace(/^\/\*\*?/, "").replace(/\*\/$/, "").replace(/^\*/, "").trim());
      if (l.startsWith("/*")) break;
      j -= 1;
    }
    return block.reverse().join(" ").trim();
  }
  while (i >= 0 && /^\s*\/\//.test(lines[i])) {
    out.push(lines[i].trim().replace(/^\/\/\/?/, "").trim());
    i -= 1;
  }
  return out.reverse().join(" ").trim();
}

// WHAT: Extracts public class/function symbols and their docs from C-family source.
// WHY: Keeps JS, Kotlin, and C++ on one regex extractor until tree-sitter is needed.
function extractCFamily(source, ext) {
  const lines = source.split("\n");
  const symbols = [];
  const moduleLanguage = [".js", ".mjs", ".ts", ".svelte"].includes(ext);
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    // Top-level only: an indented decl is a method or nested type whose parent
    // already owns the boundary. Mirrors the Python extractor's column-0 scope
    // and keeps the linter off every getter/override (the skydive 841-noise).
    if (/^\s/.test(line)) continue;
    // Non-public decls and companion holders do not own a documented boundary.
    if (/^(?:export\s+)?(?:private|internal)\b/.test(line)) continue;
    if (/^companion\s+object\b/.test(line)) continue;
    if (moduleLanguage && !/^export\b/.test(line)) continue;
    for (const re of CFAMILY_DECL) {
      const m = line.match(re);
      if (!m) continue;
      const name = m[1] || "companion";
      if (name.startsWith("_")) break;
      const kind = /class|object|interface|struct/.test(line) ? "class" : "function";
      symbols.push({ line: idx + 1, name, kind, doc: leadingComment(lines, idx) });
      break;
    }
  }
  return symbols;
}

// WHAT: Extracts top-level class/def symbols and their docstrings from Python.
// WHY: Keeps Python on its native docstring-as-child shape instead of the C-family path.
function extractPython(source) {
  const lines = source.split("\n");
  const symbols = [];
  for (let idx = 0; idx < lines.length; idx += 1) {
    const m = lines[idx].match(/^(class|def|async\s+def)\s+([A-Za-z_]\w*)/);
    if (!m) continue;
    const name = m[2];
    if (name.startsWith("_")) continue;
    const kind = m[1] === "class" ? "class" : "function";
    symbols.push({ line: idx + 1, name, kind, doc: pythonDocstring(lines, idx) });
  }
  return symbols;
}

// WHAT: Reads the triple-quoted docstring that follows a Python declaration.
// WHY: Keeps the docstring scan tolerant of decorators and the def signature lines.
function pythonDocstring(lines, declIndex) {
  let i = declIndex + 1;
  while (i < lines.length && !/:\s*(#.*)?$/.test(lines[declIndex]) && !lines[declIndex].includes(":")) i += 1;
  // advance past a multi-line signature to the first body line
  let depth = (lines[declIndex].match(/\(/g) || []).length - (lines[declIndex].match(/\)/g) || []).length;
  let body = declIndex + 1;
  let guard = declIndex;
  while (depth > 0 && guard < lines.length) {
    guard += 1;
    depth += (lines[guard].match(/\(/g) || []).length - (lines[guard].match(/\)/g) || []).length;
    body = guard + 1;
  }
  while (body < lines.length && lines[body].trim() === "") body += 1;
  if (body >= lines.length) return "";
  const first = lines[body].trim();
  const q = first.startsWith('"""') ? '"""' : first.startsWith("'''") ? "'''" : null;
  if (!q) return "";
  const single = first.slice(3);
  if (single.length >= 3 && single.endsWith(q)) return single.slice(0, -3).trim();
  const collected = [single];
  for (let j = body + 1; j < lines.length; j += 1) {
    const l = lines[j];
    if (l.includes(q)) {
      collected.push(l.slice(0, l.indexOf(q)));
      break;
    }
    collected.push(l);
  }
  return collected.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * WHAT: Extracts documented symbols from one source file by language.
 * WHY: Keeps the rule layer fed by a uniform symbol shape across languages.
 */
export function extractSymbols(source, ext) {
  return LANG_BY_EXT[ext] === "python" ? extractPython(source) : extractCFamily(source, ext);
}

/**
 * WHAT: Lints every public symbol in one file and returns located findings.
 * WHY: Keeps file path and line on each finding so the reporter stays format-free.
 */
export function lintSource(path, source, ext, options = {}) {
  const findings = lintStringStyle(path, source, ext, options.styleLines);
  for (const sym of extractSymbols(source, ext)) {
    for (const f of evaluateContract(sym.doc, { name: sym.name, kind: sym.kind, allowedWhatVerbs: options.allowedWhatVerbs })) {
      findings.push({ ...f, path, line: sym.line, suggestion: SUGGESTIONS[f.code] });
    }
    if (/\bDTO:/i.test(sym.doc) && requiresWhyName(sym.name)) {
      findings.push({
        code: "CONTRACT042",
        sev: "error",
        msg: `${sym.kind} ${sym.name}: DTO: used on domain/state symbol`,
        path,
        line: sym.line,
        suggestion: SUGGESTIONS.CONTRACT042,
      });
    }
  }
  return findings;
}

/**
 * WHAT: Loads the closest repo-local lint grammar and legacy file caps.
 * WHY: Keeps repository policy explicit instead of embedding exceptions in the engine.
 */
export function loadLintConfig(root) {
  return loadLintPolicy(resolve(expandHome(root)), DEFAULT_WHAT_VERBS);
}

const DOMAIN_SUFFIXES_REQUIRE_WHY = [
  "Calculator",
  "Coordinator",
  "Engine",
  "Policy",
  "Repository",
  "Settings",
  "Snapshot",
  "State",
  "Status",
  "Store",
  "Track",
  "Worker",
];

function requiresWhyName(name) {
  return DOMAIN_SUFFIXES_REQUIRE_WHY.some((suffix) => name.endsWith(suffix));
}

const TEST_FILE_MARKERS = [".test.", ".spec."];

/** WHAT: Expands a leading home alias in one lint target. WHY: Keeps path resolution independent from shell expansion. */
export function expandHome(path, home = process.env.HOME || "") {
  if (path === "~") return home;
  if (path?.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

/** WHAT: Resolves one CLI lint target into an absolute path. WHY: Keeps agent aliases and filesystem roots from sharing path rules. */
export function resolvePathTarget(target, cwd = process.cwd()) {
  if (!target) return cwd;
  const expanded = expandHome(target);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

function supportedSourceFile(path) {
  const name = basename(path);
  if (!SOURCE_EXTS.includes(extname(path))) return false;
  if (name.startsWith("test_")) return false;
  return !TEST_FILE_MARKERS.some((marker) => name.includes(marker));
}

function isSkippedPath(path) {
  return path.split(/[\\/]+/).some((part) => SKIP_DIRS.has(part));
}

/**
 * WHAT: Collects supported source files under one lint target.
 * WHY: Keeps trunk-relative selection and directory traversal on one path identity.
 */
export function collectSourceFiles(root, options = {}) {
  const resolvedRoot = resolve(expandHome(root));
  if (!existsSync(resolvedRoot)) return [];
  const files = [];
  const changedSet = options.changed ? changedSourcePaths(resolvedRoot, options) : null;

  const visit = (path) => {
    if (isSkippedPath(path)) return;
    const st = statSync(path);
    if (st.isDirectory()) {
      for (const child of readdirSync(path)) visit(join(path, child));
      return;
    }
    if (!st.isFile() || !supportedSourceFile(path)) return;
    if (changedSet && !changedSet.has(resolve(path))) return;
    files.push(path);
  };

  visit(resolvedRoot);
  return files.sort();
}

/** WHAT: Builds one lint result for a file or repository root. WHY: Keeps file, contract, and size findings in one report boundary. */
export function lintRoot(root, options = {}) {
  const resolvedRoot = resolve(expandHome(root));
  const files = collectSourceFiles(resolvedRoot, options);
  const lintConfig = options.lintConfig || loadLintConfig(resolvedRoot);
  const findings = lintFileSizes(resolvedRoot, files, lintConfig, options);
  let symbols = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    const fileFindings = lintSource(file, source, extname(file), { ...lintConfig, styleLines: options.changed ? changedSourceLineNumbers(resolvedRoot, file, options) : null });
    findings.push(...fileFindings);
    symbols += extractSymbols(source, extname(file)).length;
  }
  return { root: resolvedRoot, files, symbols, findings };
}

/** WHAT: Formats a line-stable baseline key for one finding. WHY: Keeps unrelated line shifts from reopening accepted legacy debt. */
export function findingFingerprint(finding, root) {
  // Line number is deliberately excluded: the message already carries the symbol
  // name + kind, so the fingerprint stays stable when unrelated edits shift lines.
  // Otherwise inserting one symbol would re-flag every baselined symbol below it.
  return `${relative(root, finding.path)}:${finding.code}:${finding.msg}`;
}

/** WHAT: Loads accepted legacy finding keys from one baseline file. WHY: Keeps missing or malformed baselines from crashing lint reads. */
export function loadBaseline(path) {
  if (!path || !existsSync(path)) return new Set();
  try {
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    return new Set(doc.findings || []);
  } catch {
    return new Set();
  }
}

/** WHAT: Saves unique finding keys for a reviewed legacy baseline. WHY: Keeps baseline generation deterministic across roots and runs. */
export function writeBaseline(path, results) {
  const fingerprints = [];
  for (const result of results) {
    for (const finding of result.findings) {
      fingerprints.push(findingFingerprint(finding, result.root));
    }
  }
  writeFileSync(path, `${JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    findings: [...new Set(fingerprints)].sort(),
  }, null, 2)}\n`);
}

/** WHAT: Builds lint results and active findings across requested roots. WHY: Keeps baseline filtering consistent for single and multi-root runs. */
export function lintRoots(roots, options = {}) {
  const results = roots.map((root) => lintRoot(root, options));
  if (options.updateBaseline && options.baselinePath) writeBaseline(options.baselinePath, results);
  const baseline = loadBaseline(options.baselinePath);
  return results.map((result) => ({
    ...result,
    activeFindings: result.findings.filter((finding) => !baseline.has(findingFingerprint(finding, result.root))),
  }));
}

function formatFinding(finding, root) {
  const base = `${relative(root, finding.path)}:${finding.line}: ${finding.code}: ${finding.msg}`;
  return finding.suggestion ? `${base}\n    Try: ${finding.suggestion}` : base;
}

/** WHAT: Formats lint totals, debt, findings, and fix guidance for the CLI. WHY: Keeps policy evaluation independent from terminal presentation. */
export function formatLintReport(results, options = {}) {
  const lines = [];
  const findingsFor = (result) => result.activeFindings || result.findings;
  const totalFiles = results.reduce((sum, result) => sum + result.files.length, 0);
  const totalSymbols = results.reduce((sum, result) => sum + result.symbols, 0);
  const totalFindings = results.reduce((sum, result) => sum + findingsFor(result).length, 0);
  const totalDebt = results.reduce((sum, result) => sum + findingsFor(result).filter((f) => f.sev === "debt").length, 0);
  lines.push("amux lint");
  lines.push(`roots: ${results.length}`);
  lines.push(`files scanned: ${totalFiles}`);
  lines.push(`symbols checked: ${totalSymbols}`);
  lines.push(`findings: ${totalFindings}`);
  if (totalDebt) lines.push(`debt: ${totalDebt}`);
  if (options.baselinePath) lines.push(`baseline: ${options.baselinePath}`);
  lines.push("");

  for (const result of results) {
    const findings = findingsFor(result);
    if (!findings.length) continue;
    const debt = findings.filter((f) => f.sev === "debt");
    const regular = findings.filter((f) => f.sev !== "debt");
    lines.push(`${basename(result.root) || result.root}:`);
    if (debt.length) {
      lines.push("  Debt:");
      for (const finding of debt.slice(0, options.limit || 80)) {
        lines.push(`  ${formatFinding(finding, result.root)}`);
      }
      if (debt.length > (options.limit || 80)) {
        lines.push(`  ... ${debt.length - (options.limit || 80)} more debt items`);
      }
    }
    if (regular.length) {
      if (debt.length) lines.push("  Findings:");
      for (const finding of regular.slice(0, options.limit || 80)) {
        lines.push(`${debt.length ? "  " : ""}${formatFinding(finding, result.root)}`);
      }
      if (regular.length > (options.limit || 80)) {
        lines.push(`${debt.length ? "  " : ""}... ${regular.length - (options.limit || 80)} more`);
      }
    }
    lines.push("");
  }

  if (totalFindings === 0) lines.push("No lint findings.");
  return lines.join("\n").trimEnd();
}

export { SKIP_DIRS, ALWAYS_BANNED, LEADING_BANNED, BOUNDARY_MARKERS, overlapRatio };
