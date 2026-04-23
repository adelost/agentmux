// Resume-hint builder — prepended to the first user-brief after amux
// spawns a new claude process so panes that lost state (WSL restart,
// amux restart, crash) can find their previous jsonl.
//
// The hint is intentionally minimal: a pointer + the last user-turn
// snippet as a self-verification anchor. Full-context agents recognize
// the snippet and ignore the hint. Empty-state agents see the snippet
// as unfamiliar and know to tail the jsonl for earlier context.

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

/** Claude Code encodes project dirs by replacing / and . with -. */
export function projectDirFor(paneDir, homeDir = process.env.HOME) {
  const slug = paneDir.replace(/[\/\.]/g, "-");
  return join(homeDir, ".claude", "projects", slug);
}

/** Newest jsonl in a project dir, or null if none. */
export function findLatestJsonl(projectDir) {
  let files;
  try {
    files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (!files.length) return null;

  const withMtime = files.map((f) => {
    const path = join(projectDir, f);
    try {
      return { path, mtime: statSync(path).mtimeMs };
    } catch {
      return { path, mtime: 0 };
    }
  });
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0].path;
}

/**
 * Walk jsonl events from newest backward, return the first meaningful
 * user turn (not compact-summary, not tool_result, not local-command
 * wrapper, not empty). { ts, text } or null.
 */
export function extractLastUserTurn(jsonlContent) {
  const lines = jsonlContent.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (d.type !== "user") continue;
    if (d.message?.role !== "user") continue;
    if (d.toolUseResult != null) continue;
    if (d.isCompactSummary || d.isSummary) continue;

    const content = d.message?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((c) => c?.type === "text")
        .map((c) => c.text || "")
        .join(" ");
    }
    if (!text) continue;
    if (/^<(local-command|command-message|command-name|command-stdout|command-stderr)/.test(text)) continue;

    return { ts: d.timestamp || null, text };
  }
  return null;
}

/** Clip text to snippet size; newlines collapse to spaces. */
export function formatSnippet(text, maxLen = 250) {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return flat.slice(0, maxLen) + "...";
}

/**
 * Full pipeline: paneDir -> hint string or null.
 * Injectable fs dep makes it unit-testable without touching disk.
 */
export function buildResumeHint(paneDir, deps = {}) {
  const { readFile = readFileSync, homeDir = process.env.HOME } = deps;

  const projectDir = projectDirFor(paneDir, homeDir);
  const jsonlPath = findLatestJsonl(projectDir);
  if (!jsonlPath) return null;

  let content;
  try { content = readFile(jsonlPath, "utf-8"); } catch { return null; }

  const turn = extractLastUserTurn(content);
  if (!turn) return null;

  const snippet = formatSnippet(turn.text);
  return [
    "[amux resume hint]",
    `Previous session: ${jsonlPath}`,
    `Last user turn${turn.ts ? ` (${turn.ts})` : ""}: "${snippet}"`,
    "If you don't recognize this, your pane likely lost state — tail the jsonl for earlier context.",
  ].join("\n");
}
