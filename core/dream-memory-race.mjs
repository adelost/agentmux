// Fleet panes log to today's daily file whenever they finish something, so a
// note can land while the Dream curator works (2026-10-08 04:01:42: lsrc:0's
// `cat >>` while claw:1 curated, and the whole night's digest was refused).
// The curator itself must not write memory: its input is untrusted journal
// text. A change is therefore accepted only when it is a pure append whose
// every line another pane typed in one of its own tool calls, and the curator
// typed none of them. Anything else keeps the old refusal.

import { statSync } from "node:fs";
import { panePathFor, readTailWindow } from "./jsonl-reader.mjs";
import { latestPaneSessionIdentity } from "./native-session-identity.mjs";
import { dreamPaneEngine } from "./dream-summarizer.mjs";

// The curator's own summary file shares short lines ("- KLART", headings)
// with fleet notes by chance; only a line this long proves it wrote the note.
const OWNER_LINE_MIN = 20;
const JOURNAL_TAIL_BYTES = 16 * 1024 * 1024;

/** WHAT: Extracts the lines added after the controller's read. WHY: Keeps any edit, removal or reorder from passing as an appended note. */
export function appendedNoteLines(before, now) {
  if (now === before) return [];
  if (!now.startsWith(before)) return null;
  return now.slice(before.length).split("\n").map((line) => line.trim()).filter(Boolean);
}

const modifiedAtMs = (path) => { try { return statSync(path).mtimeMs; } catch { return null; } };

const strings = (value, out = []) => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => strings(item, out));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => strings(item, out));
  return out;
};

// Codex function arguments are a JSON string; quotes inside a note are escaped there.
const decoded = (value) => {
  if (typeof value !== "string") return value;
  try { return [value, JSON.parse(value)]; } catch { return value; }
};

/** WHAT: Returns the text one journal event typed into tools. WHY: Keeps a pane that merely read the daily file from counting as its writer. */
export function toolCallTexts(event) {
  const blocks = event?.type === "assistant" && Array.isArray(event.message?.content) ? event.message.content : [];
  const claude = blocks.filter((block) => block?.type === "tool_use").flatMap((block) => strings(block.input));
  const payload = event?.type === "response_item" ? event.payload : null;
  const codex = ["function_call", "custom_tool_call", "local_shell_call"].includes(payload?.type)
    ? strings([decoded(payload.arguments), payload.input, payload.action]) : [];
  return [...claude, ...codex];
}

/** WHAT: Reads the tool text a journal typed since a time. WHY: Keeps the read inside the curation window of a possibly huge journal. */
export function readToolCallTextsSince(path, sinceMs, { maxBytes = JOURNAL_TAIL_BYTES } = {}) {
  if (!path || !(modifiedAtMs(path) >= sinceMs)) return [];
  const texts = [];
  for (const line of readTailWindow(path, maxBytes).text.split("\n")) {
    if (!line.includes("tool_use") && !line.includes("_call")) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!(Date.parse(event.timestamp) >= sinceMs)) continue;
    texts.push(...toolCallTexts(event));
  }
  return texts;
}

/** WHAT: Checks whether a daily-file change came only from other panes. WHY: Keeps fleet notes from costing the night's digest without letting the curator write memory. */
export function concurrentNotesVerdict(before, now, { ownerTexts, otherTexts }) {
  const lines = appendedNoteLines(before, now);
  if (lines === null) return { ok: false, reason: "edited" };
  if (lines.some((line) => line.includes("<!-- amux-dream"))) return { ok: false, reason: "dream-marker" };
  const typedBy = (texts, line) => texts.some((text) => text.includes(line));
  if (lines.some((line) => line.length >= OWNER_LINE_MIN && typedBy(ownerTexts, line))) {
    return { ok: false, reason: "curator-wrote" };
  }
  if (!lines.every((line) => typedBy(otherTexts, line))) return { ok: false, reason: "unattributed" };
  return { ok: true, lines: lines.length };
}

/**
 * WHAT: Builds the commit's judge from every coding pane's journal since the controller read the file.
 * WHY: Keeps the curator's exact session as the one writer that may not have typed a note.
 */
export function concurrentNotesJudge({ agents, owner, ownerSessionId, sinceMs,
  identityFor = latestPaneSessionIdentity, readTexts = readToolCallTextsSince }) {
  return (before, now) => {
    let ownerTexts = null;
    const otherTexts = [];
    for (const agent of agents) {
      if (agent.backend === "native") continue;
      (agent.panes || []).forEach((config, pane) => {
        const engine = dreamPaneEngine(config);
        if (!["claude", "codex"].includes(engine)) return;
        const identity = identityFor(engine, panePathFor(agent, pane));
        if (agent.name === owner.agent && pane === owner.pane) {
          if (identity?.sessionId === ownerSessionId) ownerTexts = readTexts(identity.path, sinceMs);
        } else otherTexts.push(...readTexts(identity?.path, sinceMs));
      });
    }
    if (!ownerTexts) return { ok: false, reason: "curator-journal-unknown" };
    return concurrentNotesVerdict(before, now, { ownerTexts, otherTexts });
  };
}
