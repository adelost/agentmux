// Resume-hint builder — a pointer to the previous session jsonl so a pane
// that lost state (WSL restart, crash, failed --continue) can find its
// history.
//
// Delivery (since 1.20.52): bin/amux-hook.mjs emits the hint on SessionStart
// source "startup". Claude Code injects hook stdout as hook-context, never
// as a user turn — no false wake-up turn, no hint in the jsonl, and the hint
// is born inside the right session so it cannot land in another pane (typed
// delivery demonstrably crossed panes during mass respawns, see 1.20.51).
// Other SessionStart sources stay silent on purpose: "resume" restored full
// context, "compact" has its summary, "clear" was a deliberate wipe — every
// typed hint observed in the wild (2026-07-07..09) hit a full-context pane
// as pure noise.
//
// Reach, stated honestly (api:2 review of c3e0508): on amux-spawned panes
// the hint almost never fires, and that is the design. resolveSessionFlag
// passes --continue whenever a previous jsonl exists, claude then reports
// source "resume" with context restored — nothing was lost, nothing fires.
// What remains is the true-loss class: a FRESH session starting where
// history exists. Human-typed bare `claude` in a pane dir, or amux itself
// when resolveSessionFlag cannot see the project dir (fs flake) and spawns
// bare. If that class turns out to be empty in practice, retire the hint
// rather than widen the gate — firing on every respawn was the old
// behavior and it was 100% observed noise.
//
// From 1.14.0 to 1.20.51 the hint was typed into the pane as a spawn prompt
// and therefore lives as user turns in jsonl files from that era. That is
// why stripResumeHint stays even though new hints never enter the jsonl:
// buildResumeHint reads exactly those historical files.
//
// The hint is intentionally minimal: a pointer + the last user-turn
// snippet as a self-verification anchor. Full-context agents recognize
// the snippet and ignore the hint. Empty-state agents see the snippet
// as unfamiliar and know to tail the jsonl for earlier context.

import { readdirSync, statSync } from "fs";
import { join } from "path";
import { readTailWindow } from "./jsonl-reader.mjs";

// The hint only needs the LAST user turn, which lives at the tail. Reading the
// whole session jsonl throws once it passes Node's max string length (512MB+),
// so the default reader is a bounded tail window (injectable for tests).
const RESUME_HINT_WINDOW_BYTES = 4 * 1024 * 1024;
function defaultResumeRead(jsonlPath) {
  return readTailWindow(jsonlPath, RESUME_HINT_WINDOW_BYTES).text;
}

/** Claude Code encodes project dirs by replacing / and . with -. */
export function projectDirFor(paneDir, homeDir = process.env.HOME) {
  const slug = paneDir.replace(/[\/\.]/g, "-");
  return join(homeDir, ".claude", "projects", slug);
}

/**
 * Newest jsonl in a project dir, or null if none. excludeJsonl drops the
 * session we are currently inside: at SessionStart the new session's file
 * may already exist and be the newest — without the exclusion the hint
 * would point at the very session it is trying to rescue.
 */
export function findLatestJsonl(projectDir, excludeJsonl = null) {
  let files;
  try {
    files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }

  const withMtime = files
    .map((f) => join(projectDir, f))
    .filter((path) => path !== excludeJsonl)
    .map((path) => {
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return { path, mtime: 0 };
      }
    });
  if (!withMtime.length) return null;
  withMtime.sort((a, b) => b.mtime - a.mtime);
  return withMtime[0].path;
}

/**
 * Hook-side gate: emit only on SessionStart source "startup" — a fresh
 * empty session in a pane that may have history is the one case where
 * state was actually lost. "resume" means --continue/--resume already
 * restored full context (amux spawns with --continue whenever a previous
 * jsonl exists, so this is the common respawn path), "compact" carries its
 * summary, "clear" was a deliberate wipe. Hinting those false-fires an
 * unfamiliar snippet + "you likely lost state" at a pane that lost nothing.
 */
export function shouldEmitResumeHint(payload) {
  return payload?.hook_event_name === "SessionStart" && payload?.source === "startup";
}

const HINT_HEAD = "[amux resume hint]";
const HINT_TAIL = "If you don't recognize this";

/**
 * Remove leading resume-hint block(s) from a user turn's text.
 *
 * The hint is prepended to a user brief, so it lands back in the jsonl as
 * part of a user turn. Without stripping it, the next spawn quotes the hint
 * as "the last user turn" and each restart nests one level deeper until the
 * real turn is clipped out of the snippet entirely.
 *
 * Returns "" when nothing but hint remains — caller should keep walking back.
 */
export function stripResumeHint(text) {
  let out = (text || "").trim();
  while (out.startsWith(HINT_HEAD)) {
    const lines = out.split("\n");
    // The tail is a whole line. A nested hint inside the quoted snippet is
    // flattened to one line, so it can never match at a line start.
    const tail = lines.findIndex((l) => l.startsWith(HINT_TAIL));
    if (tail === -1) return ""; // truncated hint: no real turn survives here
    out = lines.slice(tail + 1).join("\n").trim();
  }
  return out;
}

/**
 * Walk jsonl events from newest backward, return the first meaningful
 * user turn (not compact-summary, not tool_result, not local-command
 * wrapper, not a resume hint we injected ourselves, not empty).
 * { ts, text } or null.
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

    text = stripResumeHint(text);
    if (!text) continue;

    return { ts: d.timestamp || null, text };
  }
  return null;
}

/**
 * Render the hint block. Single source of truth for its shape: built from the
 * same HINT_HEAD/HINT_TAIL that stripResumeHint matches on, so the two can
 * never drift apart silently. The round-trip invariant
 * `stripResumeHint(formatHint(...)) === ""` is asserted in the tests.
 */
export function formatHint(jsonlPath, { ts, snippet }) {
  return [
    HINT_HEAD,
    `Previous session: ${jsonlPath}`,
    `Last user turn${ts ? ` (${ts})` : ""}: "${snippet}"`,
    `${HINT_TAIL}, your pane likely lost state — tail the jsonl for earlier context.`,
  ].join("\n");
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
  const { readFile = defaultResumeRead, homeDir = process.env.HOME, excludeJsonl = null } = deps;

  const projectDir = projectDirFor(paneDir, homeDir);
  const jsonlPath = findLatestJsonl(projectDir, excludeJsonl);
  if (!jsonlPath) return null;

  let content;
  try { content = readFile(jsonlPath, "utf-8"); } catch { return null; }

  const turn = extractLastUserTurn(content);
  if (!turn) return null;

  return formatHint(jsonlPath, { ts: turn.ts, snippet: formatSnippet(turn.text) });
}
