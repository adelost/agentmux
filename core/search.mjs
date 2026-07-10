// amux search — ONE search engine over every corpus an agent forgets:
// memory markdown, session jsonl (Claude + OpenClaw), the amux event ledger.
//
// Born from a benchmark (2026-07-10): the previous workspace search took
// 1m49s per query (unindexed full scan) and matched substrings ("Tess" hit
// "tessellering", "sekretess", "bältesstorlek"). ripgrep with word
// boundaries over the SAME corpora: 0.035s with the right files on top.
// Layers:
//   L1  exact phrase, word-bounded          (precision)
//   L2  all-words-in-file AND               (recall for multi-word queries)
//   L3  semantic over curated roots          (paraphrase; optional, see
//       search-semantic.mjs — degrades to lexical-only when absent)
// Hits are merged, deduped per file, and ranked by source weight + layer +
// recency. Output contract: ONE line per hit with a stable id; `--show N`
// expands. Overview first, drill on demand.
//
// Roots come from the user config (agents.yaml `search.roots`) — the engine
// is corpus-agnostic so the repo stays shareable; the personal layer is
// just config.

import { execFileSync } from "child_process";
import { readFileSync, writeFileSync, statSync, mkdirSync, existsSync } from "fs";
import { join, dirname, delimiter } from "path";

const MAX_FILESIZE = "8M"; // session jsonl lines can be huge; caps rg memory
const SNIPPET_AROUND = 60;

// ripgrep resolution: a real `rg` on PATH is fastest; when absent, Claude
// Code's own binary embeds ripgrep and activates it when argv0 is "rg" —
// every amux host runs Claude Code, so that fallback is guaranteed-present
// (discovered 2026-07-10: this machine had NO system rg; the shell function
// masking that fact only exists inside Claude Code sessions).
let rgResolved = null;
export function resolveRg() {
  if (rgResolved) return rgResolved;
  if (process.env.AMUX_RG) return (rgResolved = { file: process.env.AMUX_RG, argv0: undefined });
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir && existsSync(join(dir, "rg"))) return (rgResolved = { file: join(dir, "rg"), argv0: undefined });
  }
  const claude = process.env.CLAUDE_CODE_EXECPATH || join(process.env.HOME, ".local", "bin", "claude");
  if (existsSync(claude)) return (rgResolved = { file: claude, argv0: "rg" });
  throw new Error("varken rg eller claude hittades — installera ripgrep (eller sätt AMUX_RG)");
}

/** The ONE rg exec. Exit 1 (no match) and 2 (some unreadable files) are
 *  normal outcomes, not errors — their stdout is still the result. */
export function execRg(args) {
  const rg = resolveRg();
  try {
    return execFileSync(rg.file, args, {
      encoding: "utf-8", maxBuffer: 16 * 1024 * 1024, argv0: rg.argv0,
    });
  } catch (err) {
    if (err.status === 1 || err.status === 2) return err.stdout || "";
    throw err;
  }
}

export function expandTilde(p) {
  return p?.startsWith("~") ? join(process.env.HOME, p.slice(1)) : p;
}

/** Normalize config.search.roots; [] when unconfigured (caller hints). */
export function loadSearchRoots(config) {
  const roots = config?.search?.roots;
  if (!Array.isArray(roots)) return [];
  return roots
    .filter((r) => r?.path)
    .map((r) => ({
      name: r.name || r.path,
      path: expandTilde(String(r.path)),
      glob: r.glob || null,
      exclude: Array.isArray(r.exclude) ? r.exclude : [],
      semanticExclude: Array.isArray(r.semanticExclude) ? r.semanticExclude : [],
      weight: Number(r.weight) || 1,
      semantic: Boolean(r.semantic),
    }));
}

export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-bounded pattern with inline snippet capture: rg -o prints only the
 *  match, so multi-MB jsonl lines never reach us. */
export function snippetPattern(query) {
  return `.{0,${SNIPPET_AROUND}}\\b${escapeRegex(query)}\\b.{0,${SNIPPET_AROUND}}`;
}

function rgBaseArgs(root) {
  const args = [
    "--no-ignore", "--hidden", "-i",
    "--max-filesize", MAX_FILESIZE,
    "--no-messages",
    // -H: a SINGLE explicit file otherwise drops the path prefix (grep
    // semantics) and the path:line:match parser silently skips every hit.
    "-H", "--no-heading",
  ];
  if (root.glob) args.push("-g", root.glob);
  for (const ex of root.exclude) args.push("-g", `!${ex}`);
  return args;
}

/** rg -o -n over one root → [{path, line, snippet}]. Never throws: a root
 *  that is missing or empty is just zero hits (rg exit 1/2). */
export function runRg(pattern, root, { maxCount = 2, files = null } = {}) {
  const args = [...rgBaseArgs(root), "-o", "-n", "--max-count", String(maxCount), pattern];
  args.push(...(files?.length ? files : [root.path]));
  const out = execRg(args);
  const hits = [];
  for (const line of out.split("\n")) {
    if (!line) continue;
    // path:line:match — path may not contain ':' on this layout (abs paths)
    const m = line.match(/^(.*?):(\d+):(.*)$/);
    if (!m) continue;
    hits.push({ path: m[1], line: Number(m[2]), snippet: cleanSnippet(m[3]) });
  }
  return hits;
}

/** Files in root containing ALL words (word-bounded). Basis for L2. */
export function filesWithAllWords(words, root) {
  let files = null;
  for (const w of words) {
    const out = execRg([...rgBaseArgs(root), "-l", `\\b${escapeRegex(w)}\\b`, root.path]);
    const set = new Set(out.split("\n").filter(Boolean));
    files = files === null ? set : new Set([...files].filter((f) => set.has(f)));
    if (!files.size) return [];
  }
  return [...(files || [])];
}

/** Session-jsonl snippets are raw JSON — unescape and strip the wrapping. */
export function cleanSnippet(s) {
  return s
    .replace(/\\n/g, " ")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** YYYY-MM-DD embedded in the path (daily files, rollout names) or null. */
export function dateFromPath(path) {
  const m = path.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function hitDate(hit) {
  const fromName = dateFromPath(hit.path);
  if (fromName) return fromName;
  try {
    return new Date(statSync(hit.path).mtimeMs).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

/**
 * Rank: source weight dominates (memory over raw sessions), then layer
 * (exact > semantic > word-AND), then recency (half-life 60 days), then
 * match density. Tests assert ORDERING, not absolute numbers.
 */
export function scoreHit(hit, now = Date.now()) {
  const layerBoost = { L1: 2, sem: 1.5, L2: 1 }[hit.layer] ?? 0;
  let recency = 0;
  if (hit.date) {
    const ageDays = Math.max(0, (now - Date.parse(hit.date)) / 86_400_000);
    recency = 2 * Math.pow(0.5, ageDays / 60);
  }
  return hit.weight * 3 + layerBoost + recency + Math.min(hit.matches || 1, 3) * 0.2;
}

/** One hit per file (the best), so ten matches in one transcript don't push
 *  nine other sources off the overview. */
export function dedupeByFile(hits) {
  const best = new Map();
  for (const h of hits) {
    const prev = best.get(h.path);
    if (!prev || h.score > prev.score) best.set(h.path, { ...h, matches: (prev?.matches || 0) + (h.matches || 1) });
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

const LAST_RESULTS = () => join(process.env.HOME, ".agentmux", "search-last.json");

export function saveLastResults(query, hits, path = LAST_RESULTS()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ query, ts: new Date().toISOString(), hits }, null, 1));
  } catch { /* --show just won't work; search output already printed */ }
}

export function loadLastResults(path = LAST_RESULTS()) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * Expand hit N: markdown gets surrounding lines verbatim; jsonl gets the
 * matched event's role + text (the raw line is unreadable JSON).
 */
export function expandHit(hit, { context = 10 } = {}) {
  let lines;
  try {
    lines = readFileSync(hit.path, "utf-8").split("\n");
  } catch (err) {
    return `(kunde inte läsa ${hit.path}: ${err.message})`;
  }
  const idx = hit.line - 1;
  if (hit.path.endsWith(".jsonl")) {
    const rendered = [];
    for (let i = Math.max(0, idx - 2); i <= Math.min(lines.length - 1, idx + 2); i++) {
      const r = renderJsonlLine(lines[i]);
      if (r) rendered.push(i === idx ? `▶ ${r}` : `  ${r}`);
    }
    return rendered.join("\n") || lines[idx]?.slice(0, 2000) || "";
  }
  const from = Math.max(0, idx - context);
  const to = Math.min(lines.length - 1, idx + context);
  return lines.slice(from, to + 1)
    .map((l, i) => (from + i === idx ? `▶ ${l}` : `  ${l}`))
    .join("\n");
}

/** Best-effort human rendering of one session-jsonl event line. */
export function renderJsonlLine(raw) {
  if (!raw?.trim()) return null;
  let d;
  try { d = JSON.parse(raw); } catch { return raw.slice(0, 300); }
  const ts = (d.timestamp || d.ts || "").slice(0, 16).replace("T", " ");
  // Claude session event
  const role = d.message?.role;
  if (role) {
    const c = d.message.content;
    const text = typeof c === "string"
      ? c
      : Array.isArray(c) ? c.filter((x) => x?.type === "text").map((x) => x.text).join(" ") : "";
    if (!text) return null;
    return `${ts} ${role === "user" ? "USER" : "ASSI"}: ${cleanSnippet(text).slice(0, 500)}`;
  }
  // amux ledger event
  if (d.event) return `${ts} ${d.event} ${d.session ?? ""}:${d.pane ?? ""} ${d.detail || ""}`.trim();
  // OpenClaw / codex shapes: fall back to any text-ish field
  const text = d.text || d.content || d.payload?.text || "";
  return text ? `${ts} ${cleanSnippet(String(text)).slice(0, 500)}` : null;
}

/**
 * The full lexical pipeline over all roots. Returns ranked, deduped hits
 * with layer tags. Semantic layer is merged by the caller (optional dep).
 */
export function lexicalSearch(query, roots, { maxPerRoot = 12 } = {}) {
  const now = Date.now();
  const words = query.split(/\s+/).filter(Boolean);
  const all = [];

  for (const root of roots) {
    // L1: whole phrase, word-bounded
    const l1 = runRg(snippetPattern(query), root, { maxCount: 2 });
    for (const h of l1.slice(0, maxPerRoot)) {
      all.push(withScore({ ...h, root: root.name, weight: root.weight, layer: "L1" }, now));
    }
    // L2: multi-word AND at file level (skip when L1 already found plenty)
    if (words.length > 1 && l1.length < 3) {
      const files = filesWithAllWords(words, root).slice(0, 40);
      if (files.length) {
        const rarest = words.reduce((a, b) => (a.length >= b.length ? a : b));
        const l2 = runRg(snippetPattern(rarest), root, { maxCount: 1, files });
        for (const h of l2.slice(0, maxPerRoot)) {
          all.push(withScore({ ...h, root: root.name, weight: root.weight, layer: "L2" }, now));
        }
      }
    }
  }
  return dedupeByFile(all);
}

export function withScore(hit, now = Date.now()) {
  const date = hitDate(hit);
  const scored = { ...hit, date, matches: 1 };
  scored.score = scoreHit(scored, now);
  return scored;
}

const HOME_RE = () => new RegExp(`^${escapeRegex(process.env.HOME)}/`);

export function formatHits(hits) {
  return hits.map((h, i) => {
    const shortPath = h.path.replace(HOME_RE(), "~/");
    const layer = h.layer === "sem" ? "≈" : h.layer === "L2" ? "&" : "=";
    return `#${String(i + 1).padStart(2)} ${(h.date || "").padEnd(10)} ${h.root.padEnd(9)} ${layer} ${shortPath}\n     ${h.snippet.slice(0, 160)}`;
  }).join("\n");
}
