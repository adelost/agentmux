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

// Context window by model. Claude Code on Opus/Sonnet 4.6 opts in to the
// 1M-context beta via header; the jsonl records only the model ID, not the
// beta flag, so we key off model name. Any model not listed here uses
// CLAUDE_DEFAULT_MAX (200k).
//
// If you add a model that supports 1M context, put it here. The default
// 200k is the conservative floor for anything we don't recognize.
const CLAUDE_MODEL_MAX = {
  "claude-opus-4-6": 1_000_000,
  "claude-opus-4-7": 1_000_000,
  "claude-sonnet-4-6": 1_000_000,
};

function claudeMaxForModel(model) {
  if (!model) return CLAUDE_DEFAULT_MAX;
  // "[1m]" suffix on the model ID is Claude Code's explicit 1M-context flag,
  // independent of which dated variant we're on — trust it when present.
  if (model.includes("[1m]")) return 1_000_000;
  if (CLAUDE_MODEL_MAX[model] != null) return CLAUDE_MODEL_MAX[model];
  // Prefix match for future dated variants like "claude-opus-4-6-20260401"
  for (const prefix of Object.keys(CLAUDE_MODEL_MAX)) {
    if (model.startsWith(prefix + "-") || model.startsWith(prefix + "[")) {
      return CLAUDE_MODEL_MAX[prefix];
    }
  }
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
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const model = entry?.message?.model;
      if (model) return model;
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

  // Walk the last ~30 lines backwards for the most recent usage block
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    try {
      const entry = JSON.parse(lines[i]);
      const u = entry?.message?.usage;
      if (!u) continue;
      const total =
        (u.input_tokens || 0) +
        (u.cache_creation_input_tokens || 0) +
        (u.cache_read_input_tokens || 0) +
        (u.output_tokens || 0);
      // Pick max from the model on this same entry. Self-correcting safety
      // net: if we ever observe a total that exceeds the declared max
      // (e.g. new model not yet in the table), bump up so we don't report
      // >100% nonsense.
      const declared = claudeMaxForModel(entry.message?.model);
      const max = Math.max(declared, total);
      return { percent: Math.round((total / max) * 100), tokens: total };
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
  if (tokens === null) return null;

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

  return { percent, tokens };
}
