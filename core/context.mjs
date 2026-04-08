// Token/context tracking per agent. Reads from the dialect's session jsonl.
//
// For Claude Code: sum input + cache + output tokens from the latest
// usage block in ~/.claude/projects/{encoded}/{session}.jsonl.
//
// For Codex: read the latest token_count event from
// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl which already carries
// total_token_usage + model_context_window.

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join } from "path";

const CLAUDE_PROJECTS_DIR = () => join(process.env.HOME, ".claude", "projects");
const CODEX_SESSIONS_DIR = () => join(process.env.HOME, ".codex", "sessions");
const CLAUDE_DEFAULT_MAX = 200_000;

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

  let content;
  try {
    content = readFileSync(join(projectDir, files[0].name), "utf-8");
  } catch (err) {
    console.warn(`context(claude): read ${files[0].name} failed: ${err.message}`);
    return null;
  }
  const lines = content.trimEnd().split("\n");

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
      return { percent: Math.round((total / CLAUDE_DEFAULT_MAX) * 100), tokens: total };
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
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
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

function latestCodexSessionFor(paneDir) {
  const files = findCodexJsonlFiles(CODEX_SESSIONS_DIR())
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  for (const { path } of files) {
    const meta = readCodexMeta(path);
    if (!meta?.cwd) continue;
    if (paneDir === meta.cwd || paneDir.startsWith(meta.cwd + "/") || meta.cwd.startsWith(paneDir + "/")) {
      return path;
    }
  }
  return null;
}

function getContextFromCodexJsonl(paneDir) {
  const file = latestCodexSessionFor(paneDir);
  if (!file) return null;

  let content;
  try { content = readFileSync(file, "utf-8"); }
  catch (err) {
    console.warn(`context(codex): read ${file} failed: ${err.message}`);
    return null;
  }
  const lines = content.split("\n");

  // Walk backwards for the most recent token_count event. Use last_token_usage
  // (current turn's input+output), NOT total_token_usage (cumulative across
  // the whole session — that can exceed the context window and isn't what
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
