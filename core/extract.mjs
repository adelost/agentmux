// Extract clean text responses from raw Claude Code tmux output.
// Strategy: NEGATIVE filtering. Remove known tool/UI patterns, keep the rest.

import { TOOL_CALL as TOOL_LINE, isNoise } from "./noise.mjs";

const TOOL_RESULT = /^[  ]*⎿/;
const DIFF_LINE = /^\s+\d+\s+[+-]/;
const DIFF_CONTEXT = /^\s+\d+\s{2,}/;
const EXPANDED_HINT = /… \+\d+ lines \(ctrl\+o/;

/** Extract the last turn from raw tmux buffer (everything after the last ❯ prompt) */
const extractLastTurn = (raw) => {
  const lastPrompt = raw.lastIndexOf("\n❯ ");
  if (lastPrompt === -1) return raw;
  return raw.slice(lastPrompt);
};

/** Check if a line is a tool call */
const isToolLine = (line) => TOOL_LINE.test(line);

/** Check if a line is a tool result (⎿ prefix, diff lines, expand hints) */
const isToolResult = (line) =>
  TOOL_RESULT.test(line) || DIFF_LINE.test(line) || DIFF_CONTEXT.test(line) || EXPANDED_HINT.test(line);

/** Check if a line is a text-output bullet (● followed by actual text) */
const isTextBullet = (line) => line.startsWith("● ") && !isToolLine(line);

/**
 * Parse raw tmux buffer into structured lines with types.
 * Returns array of { type: 'text' | 'tool' | 'noise' | 'empty', content: string }
 */
const classifyLines = (raw) => {
  const lines = raw.split("\n");
  let inToolBlock = false;

  return lines.map((line) => {
    const trimmed = line.trimEnd();

    if (!trimmed) return { type: "empty", content: "" };
    if (isNoise(trimmed)) return { type: "noise", content: trimmed };

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
      return { type: "text", content: trimmed.replace(/^● /, "") };
    }

    // Non-indented line after a tool block = new text section (Claude's response)
    if (inToolBlock && !trimmed.startsWith(" ") && !trimmed.startsWith("\t")) {
      inToolBlock = false;
      return { type: "text", content: trimmed };
    }

    // Indented continuation line: belongs to whatever block we're in
    if (inToolBlock) return { type: "tool", content: trimmed };

    return { type: "text", content: trimmed };
  });
};

/**
 * Extract clean text from raw Claude Code tmux output.
 * Returns the text response with tool calls, UI noise, and diffs stripped.
 * Only processes the last turn (after the last ❯ prompt).
 */
export const extractText = (raw) => {
  const lastTurn = extractLastTurn(raw);
  const classified = classifyLines(lastTurn);
  const textLines = classified
    .filter((l) => l.type === "text")
    .map((l) => l.content);

  // Collapse multiple consecutive empty-ish lines
  const result = textLines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return result || null;
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

// Exported for testing
export { extractLastTurn, classifyLines, isToolLine, isToolResult, isNoise, isTextBullet };
