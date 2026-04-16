// Extract clean text responses from raw tmux output.
// Strategy: NEGATIVE filtering. Remove known tool/UI patterns, keep the rest.
//
// Dialect-agnostic: all Claude/Codex differences live in ./dialects.mjs.
// This module combines dialect data to classify each line.

import { isNoise, isToolCall } from "./noise.mjs";
import {
  matchesAnyBullet,
  matchesAnyToolResult,
  matchesAnyPromptWithText,
  matchesAnyPromptPrefix,
  stripBullet,
  ALL_DIALECTS,
} from "./dialects.mjs";

// Non-dialect-specific patterns (diff rendering, expand hints)
const DIFF_LINE = /^\s+\d+\s+[+-]/;
const DIFF_CONTEXT = /^\s+\d+\s{2,}/;
const EXPANDED_HINT = /… \+\d+ lines \(ctrl\+o/;

// --- Turn extraction -----------------------------------------------------

/** Extract the last turn from raw tmux buffer (everything after the last user prompt) */
const extractLastTurn = (raw) => {
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (matchesAnyPromptWithText(lines[i])) {
      return lines.slice(i).join("\n");
    }
  }
  return raw;
};

/**
 * Extract a specific turn matching a known prompt text.
 * Way more reliable than extractLastTurn when there are multiple turns in scrollback.
 */
export function extractTurnByPrompt(raw, promptText) {
  if (!promptText) return extractLastTurn(raw);
  const promptStart = promptText.trim().slice(0, 60);
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (matchesAnyPromptPrefix(line) && line.slice(2).trim().startsWith(promptStart)) {
      return lines.slice(i).join("\n");
    }
  }
  return extractLastTurn(raw);
}

// --- Line classification -------------------------------------------------

/** Check if a line is a tool call (any dialect) */
const isToolLine = (line) => isToolCall(line);

/** Check if a line is a tool result (⎿/└ prefix, diff lines, expand hints) */
const isToolResult = (line) =>
  matchesAnyToolResult(line) || DIFF_LINE.test(line) || DIFF_CONTEXT.test(line) || EXPANDED_HINT.test(line);

/** Check if a line is a text-output bullet (● or • followed by actual text, but not a tool call) */
const isTextBullet = (line) => matchesAnyBullet(line) && !isToolLine(line);

/** True if a line starts with any dialect's prompt glyph (noise-worthy prompt line) */
const isPromptLine = (line) =>
  ALL_DIALECTS.some((d) => line.startsWith(d.promptChar));

/**
 * Parse raw tmux buffer into structured lines with types.
 * Returns array of { type: 'text' | 'tool' | 'noise' | 'empty', content: string }
 *
 * Tracks two kinds of block state across lines:
 *   inToolBlock - indented lines belong to a preceding tool call
 *   inPromptCont - indented lines belong to a preceding wordwrapped prompt
 *
 * Wordwrapped prompt example (narrow pane):
 *   ❯ Ge mig en mindre berättelse om en
 *     katt... som hoppar fallskärm        <- this is continuation of the prompt
 *   ● Whiskers första hopp                <- this is the real response
 *
 * Without inPromptCont tracking, "  katt..." would fall through to the default
 * text classifier and leak into the extracted response.
 */
const classifyLines = (raw) => {
  const lines = raw.split("\n");
  let inToolBlock = false;
  let inPromptCont = false;

  return lines.map((rawLine) => {
    const trimmed = rawLine.trimEnd();
    const isIndented = rawLine.startsWith(" ") || rawLine.startsWith("\t");

    if (!trimmed) {
      inPromptCont = false;
      return { type: "empty", content: "" };
    }

    // Prompt continuation (wordwrapped): indented line following a prompt line
    // that isn't itself a bullet, tool-result, or new tool call.
    if (inPromptCont && isIndented && !matchesAnyBullet(trimmed) && !isToolLine(trimmed) && !isToolResult(trimmed)) {
      return { type: "noise", content: trimmed };
    }

    if (isNoise(trimmed)) {
      // Start tracking prompt continuation when we see a prompt line
      inPromptCont = isPromptLine(trimmed);
      return { type: "noise", content: trimmed };
    }

    // Any non-noise content resets prompt-continuation state
    inPromptCont = false;

    if (isToolLine(trimmed)) {
      inToolBlock = true;
      return { type: "tool", content: trimmed };
    }

    if (isToolResult(trimmed)) {
      inToolBlock = true;
      return { type: "tool", content: trimmed };
    }

    if (isTextBullet(trimmed)) {
      inToolBlock = false;
      return { type: "text", content: stripBullet(trimmed) };
    }

    // Non-indented line after a tool block = new text section
    if (inToolBlock && !isIndented) {
      inToolBlock = false;
      return { type: "text", content: trimmed };
    }

    // Indented continuation line: belongs to whatever block we're in
    if (inToolBlock) return { type: "tool", content: trimmed };

    return { type: "text", content: trimmed };
  });
};

// --- De-wrap ------------------------------------------------------------

/**
 * Join wordwrapped continuation lines within a paragraph into a single line.
 *
 * Narrow tmux panes (42 col in main-vertical layouts) make Claude break each
 * sentence across multiple lines. In Discord those lines become separate
 * paragraphs which looks broken. Discord already wordwraps on its own, so
 * we want one line per logical paragraph.
 *
 * Rules:
 *   - Empty line  → paragraph break (flush current + keep the blank)
 *   - List item (- / * / • / 1.) → its own line (flush first)
 *   - Fenced code block (```) → flushed and kept on its own line
 *   - Everything else → append to the current paragraph, joined with space
 */
const LIST_OR_FENCE = /^(```|[-*+•]\s|\d+\.\s)/;

export function dewrapParagraphs(text) {
  const lines = text.split("\n");
  const out = [];
  let current = [];

  const flush = () => {
    if (current.length) out.push(current.join(" "));
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      out.push("");
      continue;
    }
    if (LIST_OR_FENCE.test(trimmed)) {
      flush();
      out.push(trimmed);
      continue;
    }
    current.push(trimmed);
  }
  flush();

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// --- High-level extract --------------------------------------------------

/**
 * Extract clean text from raw tmux output.
 * Returns the text response with tool calls, UI noise, and diffs stripped.
 * Only processes the last turn. Wordwrapped paragraphs are dewrapped.
 */
export const extractText = (raw) => {
  const lastTurn = extractLastTurn(raw);
  const classified = classifyLines(lastTurn);
  const textLines = classified
    .filter((l) => l.type === "text" || l.type === "empty")
    .map((l) => l.content);

  return dewrapParagraphs(textLines.join("\n")) || null;
};

/**
 * Split classified lines into text segments (blocks between tool calls).
 * Only tool/noise lines cause a segment break. Empty lines stay in the segment.
 */
export const extractSegments = (classified) => {
  const segments = [];
  let current = [];
  for (const l of classified) {
    if (l.type === "text" || l.type === "empty") {
      current.push(l.type === "text" ? l.content : "");
    } else if (current.length) {
      const text = current.join("\n").trim();
      if (text) segments.push(text);
      current = [];
    }
  }
  const last = current.join("\n").trim();
  if (last) segments.push(last);
  return segments.filter(Boolean);
};

/**
 * Format a raw tool call line into a compact one-liner.
 * Claude: "● Bash(cd /skybar && pwd)" → "Bash cd /skybar && pwd"
 * Claude: "● Read(file.ts)" → "Read file.ts"
 * Codex:  "• Ran date '+%F'" → "Ran date '+%F'"
 * Codex:  "• Explored" → "Explored"
 */
export function formatToolCall(rawLine) {
  const stripped = stripBullet(rawLine).trim();
  // Match Tool(args) pattern (Claude style)
  const match = stripped.match(/^([A-Z][a-zA-Z]+)\((.*)\)\s*$/);
  if (!match) return stripped;

  const [, tool, rawArgs] = match;
  let args = rawArgs;

  if (tool === "Bash") {
    args = args.length > 80 ? args.slice(0, 77) + "..." : args;
  } else if (tool === "Read" || tool === "Write" || tool === "Edit") {
    args = args.split(/[,\s]/)[0];
    const parts = args.split("/");
    if (parts.length > 3) args = ".../" + parts.slice(-2).join("/");
  } else if (tool === "Glob" || tool === "Grep") {
    args = args.length > 60 ? args.slice(0, 57) + "..." : args;
  }

  return `${tool} ${args}`;
}

/**
 * Extract a stream of items (text segments + tool calls) in order.
 * Returns array of { type: 'text' | 'tool', content: string }
 */
export function extractMixedStream(classified) {
  const items = [];
  let textBuffer = [];

  const flushText = () => {
    const text = dewrapParagraphs(textBuffer.join("\n"));
    if (text) items.push({ type: "text", content: text });
    textBuffer = [];
  };

  for (const line of classified) {
    if (line.type === "text") {
      textBuffer.push(line.content);
    } else if (line.type === "empty") {
      textBuffer.push("");
    } else if (line.type === "tool") {
      // Only the first line of a tool block (the bullet line, not the result continuation)
      if (matchesAnyBullet(line.content)) {
        flushText();
        items.push({ type: "tool", content: formatToolCall(line.content) });
      }
      // Skip ⎿/└ results, indented continuations, etc
    }
  }
  flushText();
  return items;
}

// Exported for testing
export { extractLastTurn, classifyLines, isToolLine, isToolResult, isNoise, isTextBullet };
