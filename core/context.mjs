// Token/context tracking per agent. Reads from the dialect's session jsonl.
//
// For Claude Code: sum input + cache + output tokens from the latest
// usage block in ~/.claude/projects/{encoded}/{session}.jsonl.
//
// For Codex: read the latest token_count event from
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl which already carries
// total_token_usage + model_context_window.

import { readFileSync, readdirSync, statSync, existsSync, openSync, fstatSync, readSync, closeSync } from "fs";
import { join } from "path";

/**
 * Read only the last `maxBytes` of a file and return its complete trailing
 * lines (the partial leading line is dropped). Claude session jsonl grows to
 * 100MB+, and every consumer here only inspects the last ~30 lines for the
 * newest usage/model block — reading the whole file just to look at the tail
 * was a multi-hundred-ms-per-pane cost in `amux ps`. Falls back to a full
 * read when the file is small or anything fails.
 */
/** Read only the first `maxBytes` of a file as a string. */
function readHeadBytes(filePath, maxBytes = 64 * 1024) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    const n = Math.min(size, maxBytes);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, 0);
    return buf.toString("utf-8");
  } catch {
    try { return readFileSync(filePath, "utf-8"); } catch { return ""; }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

function readTailLines(filePath, maxBytes = 1024 * 1024) {
  let fd;
  try {
    fd = openSync(filePath, "r");
    const size = fstatSync(fd).size;
    if (size <= maxBytes) {
      return readFileSync(filePath, "utf-8").trimEnd().split("\n");
    }
    const buf = Buffer.alloc(maxBytes);
    readSync(fd, buf, 0, maxBytes, size - maxBytes);
    const text = buf.toString("utf-8");
    const nl = text.indexOf("\n");
    return (nl === -1 ? text : text.slice(nl + 1)).trimEnd().split("\n");
  } catch {
    try { return readFileSync(filePath, "utf-8").trimEnd().split("\n"); }
    catch { return []; }
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
}

const CLAUDE_PROJECTS_DIR = () => join(process.env.HOME, ".claude", "projects");
const CODEX_SESSIONS_DIR = () => join(process.env.HOME, ".codex", "sessions");
const CLAUDE_DEFAULT_MAX = 200_000;

// Per-model overrides for context window. Claude Code on Opus/Sonnet opts in
// to the 1M-context beta via header; the jsonl records only the model ID, not
// the beta flag, so we key off model name. This table is now ONLY for
// exceptions to the family heuristic below — you should rarely need to touch
// it, because new dated Opus/Sonnet variants resolve to 1M automatically.
const CLAUDE_MODEL_MAX = {
  // (empty — opus/sonnet handled by family heuristic, haiku by family floor)
};

// Family → context window. Opus, Sonnet and Fable (4.x and forward) run the
// 1M-context beta under Claude Code; Haiku tops out at 200k. Keying off the
// family rather than an exact-version allowlist means future models
// (claude-opus-4-9, claude-sonnet-5-0, …) get the right window with no code
// change — that allowlist staleness is exactly what made an opus-4-8 pane
// misread 288k/200k as 100% and fire false auto-compacts. The failure
// direction is now safe: an unknown future Opus we wrongly assume is 1M only
// ever UNDER-reports % (a late compact, harmless) rather than the false-100%
// that destroys live context, and the self-correcting ceiling
// (max = max(declared, total)) still caps >100%.
const CLAUDE_FAMILY_MAX = [
  [/^claude-(opus|sonnet|fable)-/, 1_000_000],
  [/^claude-haiku-/, 200_000],
];

// Unknown claude-* FAMILY (a name not in the table above — fable was the
// second burn after opus-4-8) defaults to 1M, not 200k. Rationale: every new
// big model under Claude Code has shipped with the 1M window, and the failure
// directions are asymmetric — assuming 1M for a true-200k model means amux
// never auto-compacts it (Claude Code's own compaction still protects the
// pane), while assuming 200k for a true-1M model fires a false /compact that
// destroys live context (observed: fable pane at 174k read as 87% and got
// force-compacted mid-task). Only haiku is known-small, and it is matched
// explicitly above. Non-claude / missing model strings keep the 200k default.
const CLAUDE_UNKNOWN_FAMILY_MAX = 1_000_000;

const totalUsageTokens = (u) =>
  (u.input_tokens || 0) +
  (u.cache_creation_input_tokens || 0) +
  (u.cache_read_input_tokens || 0) +
  (u.output_tokens || 0);

// Session-limit / API-error turns are recorded as assistant messages from
// model "<synthetic>" with an all-zero usage block ("You've hit your session
// limit…"). They are not real turns, and trusting them poisons the context
// reading in BOTH directions at once (ai:1, 2026-07-08 18:50 — three
// consumers reported 0%, 33% and 100% for the same pane):
//   - zero usage read as "latest usage" → 0% false calm
//   - "<synthetic>" read as "latest model" → default 200k window, so a real
//     ~351k-token session clamps to a false 100% → false auto-compact warning
// Context truth is the newest REAL model turn — skip synthetic entries.
function isSyntheticUsageEntry(message) {
  if (message?.model === "<synthetic>") return true;
  const u = message?.usage;
  return u ? totalUsageTokens(u) === 0 : false;
}

// Backward-scan bound while skipping synthetic spam. A rate-limited pane
// appends synthetic entries for every delivered prompt (165 observed in one
// session), so a 30-line window can be ALL synthetic. 500 lines bounds the
// worst case; past it we return null (honest "no data") rather than fabricate.
const USAGE_SCAN_MAX_LINES = 500;

function claudeMaxForModel(model) {
  if (!model) return CLAUDE_DEFAULT_MAX;
  // "[1m]" suffix on the model ID is Claude Code's explicit 1M-context flag,
  // independent of which dated variant we're on — trust it when present.
  if (model.includes("[1m]")) return 1_000_000;
  // Explicit per-model override wins over the family heuristic.
  if (CLAUDE_MODEL_MAX[model] != null) return CLAUDE_MODEL_MAX[model];
  for (const prefix of Object.keys(CLAUDE_MODEL_MAX)) {
    if (model.startsWith(prefix + "-") || model.startsWith(prefix + "[")) {
      return CLAUDE_MODEL_MAX[prefix];
    }
  }
  // Family heuristic — the durable default that survives new model releases.
  for (const [pattern, max] of CLAUDE_FAMILY_MAX) {
    if (pattern.test(model)) return max;
  }
  // New claude family we've never seen → assume the big window (safe
  // direction: worst case a late compact, never a false one).
  if (/^claude-/.test(model)) return CLAUDE_UNKNOWN_FAMILY_MAX;
  return CLAUDE_DEFAULT_MAX;
}

// Read the most recent claude model name from any jsonl in paneDir's project
// store. Used by the pane-content path to infer max context window when the
// pane itself is too narrow to show the "(1M context)" hint.
function readLatestClaudeModel(paneDir) {
  const projectDir = join(CLAUDE_PROJECTS_DIR(), encodeClaudePath(paneDir));
  if (!existsSync(projectDir)) return null;
  let files;
  try {
    files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return null; }
  if (!files.length) return null;
  const lines = readTailLines(join(projectDir, files[0].name));
  if (!lines.length) return null;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - USAGE_SCAN_MAX_LINES); i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const model = entry?.message?.model;
      if (model && model !== "<synthetic>") return model;
    } catch {}
  }
  return null;
}

// --- Claude path -------------------------------------------------------

function encodeClaudePath(dir) {
  return dir.replace(/[\/\.]/g, "-");
}

function getContextFromClaudeJsonl(paneDir) {
  const projectDir = join(CLAUDE_PROJECTS_DIR(), encodeClaudePath(paneDir));
  if (!existsSync(projectDir)) return null;

  let files;
  try {
    files = readdirSync(projectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (err) {
    console.warn(`context(claude): list projectDir failed: ${err.message}`);
    return null;
  }
  if (!files.length) return null;

  const lines = readTailLines(join(projectDir, files[0].name));
  if (!lines.length) return null;

  // Walk backwards for the most recent REAL usage block (synthetic
  // session-limit entries are skipped — see isSyntheticUsageEntry).
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - USAGE_SCAN_MAX_LINES); i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const u = entry?.message?.usage;
      if (!u) continue;
      if (isSyntheticUsageEntry(entry.message)) continue;
      const total = totalUsageTokens(u);
      // Pick max from the model on this same entry. Self-correcting safety
      // net: if we ever observe a total that exceeds the declared max
      // (e.g. new model not yet in the table), bump up so we don't report
      // >100% nonsense.
      const declared = claudeMaxForModel(entry.message?.model);
      const max = Math.max(declared, total);
      return {
        percent: Math.round((total / max) * 100),
        tokens: total,
        model: entry.message?.model ?? null,
      };
    } catch {
      // malformed line, try the next
    }
  }
  return null;
}

// --- Codex path --------------------------------------------------------

function findCodexJsonlFiles(dir, depth = 0, acc = []) {
  if (depth > 4 || !existsSync(dir)) return acc;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) findCodexJsonlFiles(path, depth + 1, acc);
    else if (e.name.endsWith(".jsonl")) acc.push(path);
  }
  return acc;
}

function readCodexMeta(filePath) {
  try {
    // session_meta is the FIRST event in a codex rollout. This is called for
    // every session file while resolving which one belongs to a pane, so a
    // full readFileSync here meant reading hundreds of multi-MB files just to
    // inspect their first line — the dominant cost in `amux ps`/`done` with a
    // large ~/.codex/sessions. Read only the head.
    const head = readHeadBytes(filePath);
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "session_meta") return event.payload;
      } catch {}
      break;
    }
  } catch {}
  return null;
}

// Process-lifetime cache of the codex session index: [{ path, mtime, cwd }]
// newest-first. `amux ps`/`done` resolve a session per codex pane, and each
// resolution used to re-walk + re-stat + re-head-read all of ~/.codex/sessions
// (hundreds of files). Building it once per process collapses that N×
// duplicate scan to a single pass. A CLI invocation lives ~1s, so staleness
// is a non-issue; the cache dies with the process.
let _codexIndex = null;
function codexSessionIndex() {
  if (_codexIndex) return _codexIndex;
  _codexIndex = findCodexJsonlFiles(CODEX_SESSIONS_DIR())
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map(({ path, mtime }) => ({ path, mtime, cwd: readCodexMeta(path)?.cwd || null }));
  return _codexIndex;
}

function latestCodexSessionFor(paneDir) {
  for (const { path, cwd } of codexSessionIndex()) {
    if (!cwd) continue;
    if (paneDir === cwd || paneDir.startsWith(cwd + "/") || cwd.startsWith(paneDir + "/")) {
      return path;
    }
  }
  return null;
}

function getContextFromCodexJsonl(paneDir) {
  const file = latestCodexSessionFor(paneDir);
  if (!file) return null;

  // token_count events are emitted every turn, so the most recent one lives
  // in the file's tail — no need to read the whole rollout (can be many MB).
  const lines = readTailLines(file);

  // Walk backwards for the most recent token_count event. Use last_token_usage
  // (current turn's input+output), NOT total_token_usage (cumulative across
  // the whole session, which can exceed the context window and isn't what
  // "context used" means).
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    try {
      const entry = JSON.parse(lines[i]);
      if (entry?.type !== "event_msg") continue;
      if (entry.payload?.type !== "token_count") continue;
      const info = entry.payload.info;
      const last = info?.last_token_usage;
      if (!last) continue;
      // input_tokens already includes cached_input_tokens (they're a subset).
      // Add output tokens that contribute to the current turn's context.
      const tokens = (last.input_tokens || 0) + (last.output_tokens || 0);
      const max = info.model_context_window || 256_000;
      return { percent: Math.round((tokens / max) * 100), tokens };
    } catch {
      // malformed line
    }
  }
  return null;
}

// --- Public dispatcher -------------------------------------------------

/**
 * Get { percent, tokens } context usage for a pane, routed to the right
 * source by dialect name. Returns null if no data is available.
 *
 * @param {string} paneDir   - The pane's working dir
 * @param {"claude"|"codex"|null} dialect - Which session store to read
 */
export function getContextPercent(paneDir, dialect) {
  if (dialect === "codex") return getContextFromCodexJsonl(paneDir);
  if (dialect === "claude") return getContextFromClaudeJsonl(paneDir);
  return null;
}

// --- Pane-content path -------------------------------------------------
//
// The jsonl path above keys off cwd, so multiple claude panes sharing a
// workspace all resolve to the same "latest session" and report the same
// number. The pane's own status bar is per-pane correct because each pane
// renders its own live counter. This path reads those numbers directly.

const BLOCK_CHARS = /[█▓▒░]/;

/**
 * Read Claude Code's OWN context percent from a custom statusline row.
 *
 * Why this exists (2026-06-10 incident): a pane with a custom statusline
 * ("/gsd-update | claude-fable-5[1m] | ▓▓░░ 92%") has NO "N tokens" counter
 * line, so the token-anchored parse fails and callers fall back to jsonl
 * math — which divides by the RAW model window (769k/1M = 77%) while Claude
 * Code's number is measured against usable-space-before-autocompact (92%).
 * The two can differ by 15+ points near the limit, exactly where it matters.
 * Claude Code's own rendered percent is the truth users see and the number
 * its compaction acts on, so when it is on screen, never recompute it.
 *
 * Anchors (all three required, bottom-15 lines only, to keep pasted chat
 * logs / download bars from false-matching):
 *   - a claude model id on the line ("claude-fable-5[1m]")
 *   - a percent
 *   - statusline shape: a progress bar OR pipe-separated segments
 *
 * Tokens are not on the statusline row; they come from the jsonl fallback
 * purely for display ("(769k)") and may be null. Consumers must treat
 * percent as the authoritative field.
 */
function getContextFromStatusline(tail, paneDir = null) {
  const bottom = tail.slice(-15);
  for (let i = bottom.length - 1; i >= 0; i--) {
    const line = bottom[i];
    const modelMatch = line.match(/claude-[a-z][\w.-]*(\[\d+m\])?/i);
    if (!modelMatch) continue;
    if (!(BLOCK_CHARS.test(line) || line.includes("|"))) continue;
    const matches = [...line.matchAll(/(\d{1,3})\s*%/g)];
    if (!matches.length) continue;
    const percent = parseInt(matches[matches.length - 1][1]);
    if (percent < 0 || percent > 100) continue;
    let tokens = null;
    if (paneDir) {
      try {
        tokens = getContextFromClaudeJsonl(paneDir)?.tokens ?? null;
      } catch { /* display-only — percent stands alone */ }
    }
    return { percent, tokens, model: modelMatch[0] };
  }
  return null;
}

/**
 * Display-short model name: "claude-fable-5[1m]" → "fable-5·1m",
 * "claude-opus-4-8" → "opus-4-8". Null-safe for unknown/missing.
 */
export function shortModelName(model) {
  if (!model) return null;
  return model.replace(/^claude-/, "").replace(/\[1m\]$/i, "·1m");
}

/**
 * Extract context usage from a tmux pane's captured content.
 *
 * Handles three visible states:
 *   - Active wide:    progress bar "N ████░░░░░░ NN%" + counter "N tokens"
 *   - Active narrow:  counter "N tokens" only (progress bar truncated away)
 *   - Idle:           "new task? /clear to save N.Nk tokens"
 *
 * If the pane is too narrow to show "(1M context)" the max is read from the
 * latest jsonl in paneDir as fallback.
 *
 * @param {string} paneContent - Output from tmux capture-pane (ANSI-stripped)
 * @param {string|null} paneDir - The pane's cwd, for model fallback. Optional.
 * @returns {{ percent: number, tokens: number } | null}
 */
export function getContextFromPane(paneContent, paneDir = null) {
  if (!paneContent) return null;
  const lines = paneContent.split("\n");
  const tail = lines.slice(-80);

  // Tokens: the status bar's own line is "<spaces>N tokens" with nothing
  // else on it. Anchoring to a pure line avoids matching "✻ Musing… (↓ 40
  // tokens)" delta indicators or chat text that mentions tokens.
  let tokens = null;
  let tokenLineIndex = -1;
  let tokenSource = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    let m = line.match(/^\s*(\d+)\s+tokens\s*$/);
    if (m) {
      tokens = parseInt(m[1]);
      tokenLineIndex = i;
      tokenSource = "counter";
      break;
    }
    m = line.match(/save\s+(\d+(?:\.\d+)?)k\s+tokens/i);
    if (m) {
      tokens = Math.round(parseFloat(m[1]) * 1000);
      tokenLineIndex = i;
      tokenSource = "idle-save";
      break;
    }
  }
  if (tokens === null) return getContextFromStatusline(tail, paneDir);

  // Percent from the progress bar that belongs to the same visible status
  // block as the token counter. Do not let an idle "save N tokens" hint
  // inherit stale progress from scrollback, and do not cross a prompt
  // boundary while looking upward from the token line.
  let percent = null;
  if (tokenSource === "counter") {
    const firstCandidate = Math.max(0, tokenLineIndex - 8);
    for (let i = tokenLineIndex; i >= firstCandidate; i--) {
      const line = tail[i];
      if (/^\s*❯/.test(line)) break;
      if (BLOCK_CHARS.test(line)) {
        const m = line.match(/(\d+)\s*%/);
        if (m) { percent = parseInt(m[1]); break; }
      }
    }
  }

  if (percent === null) {
    let max = null;
    if (/\(1M context\)/i.test(paneContent)) max = 1_000_000;
    if (max === null && paneDir) {
      const model = readLatestClaudeModel(paneDir);
      if (model) max = claudeMaxForModel(model);
    }
    if (max === null) max = CLAUDE_DEFAULT_MAX;
    percent = Math.min(100, Math.round((tokens / max) * 100));
  }

  let model = null;
  if (paneDir) {
    try { model = readLatestClaudeModel(paneDir); } catch { /* display-only */ }
  }
  return { percent, tokens, model };
}
