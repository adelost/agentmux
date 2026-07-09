// THE Claude Code path encoding — the one place that knows how Claude maps
// a pane cwd to its ~/.claude/projects/<slug>/ session dir. Five modules
// used to carry private copies of the replace() line (agent.mjs,
// core/context.mjs, core/resume-hint.mjs, core/jsonl-reader.mjs,
// channels/jsonl-watcher.mjs) — if Claude Code ever changed the encoding,
// four of five would have rotted silently. Now this file is the only edit.

import { readdirSync } from "fs";
import { join } from "path";

/** Every `/` and `.` becomes `-`: /home/u/lsrc/.agents/1 → -home-u-lsrc--agents-1 */
export function claudeProjectSlug(dir) {
  return dir.replace(/[\/\.]/g, "-");
}

/** ~/.claude/projects/<slug> for a pane cwd. */
export function claudeProjectDir(dir, homeDir = process.env.HOME) {
  return join(homeDir, ".claude", "projects", claudeProjectSlug(dir));
}

/**
 * Probe a project dir for session history. ENOENT is the one legitimate
 * "no history" miss (first-ever session for this dir); any other failure
 * is surfaced as { error } instead of swallowed — a swallowed readdir
 * failure at spawn time is how a pane's resume silently downgrades to a
 * fresh session, i.e. context loss over a transient fs flake (WSL/9p
 * class; api:2 review of 1.20.52).
 */
export function classifyHistoryRead(projectDir, { readdir = readdirSync } = {}) {
  try {
    return { history: readdir(projectDir).some((f) => f.endsWith(".jsonl")) };
  } catch (err) {
    if (err?.code === "ENOENT") return { history: false };
    return { history: false, error: err };
  }
}
