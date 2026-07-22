// Per-caller search drill-down state. Search results are runtime UI state,
// never shared fleet truth: each pane or terminal owns its own atomic file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

function safeScope(value) {
  return String(value || "").replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "unknown";
}

/** WHAT: Returns drill-down state for one invoking pane or terminal. WHY: Prevents concurrent agents from replacing each other's `--show N` result list. */
export function defaultSearchStatePath({ env = process.env, parentPid = process.ppid } = {}) {
  const explicit = env.AMUX_SEARCH_SCOPE;
  const scope = explicit
    ? `scope-${safeScope(explicit)}`
    : env.TMUX_PANE
      ? `tmux-${safeScope(env.TMUX_PANE)}`
      : `terminal-${safeScope(parentPid)}`;
  return join(env.HOME, ".agentmux", "search-last", `${scope}.json`);
}

/** WHAT: Stores one caller's ranked hits atomically. WHY: Keeps concurrent search processes from exposing partial JSON. */
export function saveLastResults(query, hits, path = defaultSearchStatePath()) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, query, ts: new Date().toISOString(), hits }, null, 1));
    renameSync(temporary, path);
  } catch { /* --show just won't work; search output already printed */ }
}

/** WHAT: Loads one caller's prior result list. WHY: Rejects malformed runtime state instead of rendering arbitrary shapes. */
export function loadLastResults(path = defaultSearchStatePath()) {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8"));
    if (!value || typeof value.query !== "string" || !Array.isArray(value.hits)) return null;
    return value;
  } catch {
    return null;
  }
}
