import { detectDialect } from "./dialects.mjs";

/** WHAT: Reads the existing dialect-driven tmux activity fallback. WHY: Keeps the agent facade under its cap while preserving screen-only engine observation. */
export function isBusyFromTmux(raw) {
  const dialect = detectDialect(raw);
  if (dialect.busySignals?.some(signal => typeof signal === "string" ? raw.includes(signal) : signal.test(raw))) return true;
  if (!dialect.idleWhenPromptEmpty) return false;
  const tail = raw.split("\n").map(line => line.trim()).filter(Boolean).slice(-10);
  const prompt = tail.findLast(line => line.startsWith(dialect.promptChar));
  return !prompt || prompt.slice(dialect.promptChar.length).trim().length > 0;
}

/** WHAT: Filters Gemini's submitted prompt box from a selected TUI turn. WHY: Prevents the user's brief from leaking into the mirrored answer. */
export function geminiReplyTurn(turn) {
  const lines = turn.split("\n");
  const border = lines.findIndex(line => /^▀{3,}\s*$/u.test(line));
  return border < 0 ? "" : lines.slice(border + 1).join("\n");
}
