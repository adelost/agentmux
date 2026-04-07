// Extract clean text responses from raw Claude Code tmux output.
// Strategy: NEGATIVE filtering. Remove known tool/UI patterns, keep the rest.

import { TOOL_CALL as TOOL_LINE, isNoise } from "./noise.mjs";

const TOOL_RESULT = /^[  ]*⎿/;
const DIFF_LINE = /^\s+\d+\s+[+-]/;
const DIFF_CONTEXT = /^\s+\d+\s{2,}/;
const EXPANDED_HINT = /… \+\d+ lines \(ctrl\+o/;

/** Extract the last turn from raw tmux buffer (everything after the last user prompt) */
const extractLastTurn = (raw) => {
  // Find the LAST user input prompt (❯ followed by non-whitespace text on same line).
  // Empty idle prompts (just ❯) and ❯ inside other text are skipped.
  // We search backwards by splitting on lines.
  const lines = raw.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Match user input: ❯ followed by space and actual text
    if (/^❯ \S/.test(line)) {
      return lines.slice(i).join("\n");
    }
  }
  // No user prompt found - return everything (first turn)
  return raw;
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

/**
 * Format a raw tool call line into a compact one-liner.
 * "● Bash(cd /skybar && pwd)" → "Bash cd /skybar && pwd"
 * "● Read(file.ts)" → "Read file.ts"
 * "● Edit(file.svelte)" → "Edit file.svelte"
 */
export function formatToolCall(rawLine) {
  const stripped = rawLine.replace(/^●\s*/, "").trim();
  // Match Tool(args) pattern
  const match = stripped.match(/^([A-Z][a-zA-Z]+)\((.*)\)\s*$/);
  if (!match) return stripped;

  const [, tool, rawArgs] = match;
  let args = rawArgs;

  // Tool-specific simplification
  if (tool === "Bash") {
    // Truncate long commands
    args = args.length > 80 ? args.slice(0, 77) + "..." : args;
  } else if (tool === "Read" || tool === "Write" || tool === "Edit") {
    // Just the filename, no full path if too long
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
    const text = textBuffer.join("\n").trim();
    if (text) items.push({ type: "text", content: text });
    textBuffer = [];
  };

  for (const line of classified) {
    if (line.type === "text") {
      textBuffer.push(line.content);
    } else if (line.type === "empty") {
      textBuffer.push("");
    } else if (line.type === "tool") {
      // Only the first line of a tool block (the ● line, not the ⎿ result)
      if (line.content.startsWith("●")) {
        flushText();
        items.push({ type: "tool", content: formatToolCall(line.content) });
      }
      // Skip ⎿ results, indented continuations, etc
    }
  }
  flushText();
  return items;
}

// Exported for testing
export { extractLastTurn, classifyLines, isToolLine, isToolResult, isNoise, isTextBullet };
