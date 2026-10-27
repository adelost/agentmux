import { detectDialect, GEMINI } from "./dialects.mjs";

/** WHAT: Resolves the dialect for a screen-only pane. WHY: Keeps a configured Gemini pane from losing its dialect when agy's banner scrolls away. */
export const tmuxDialectFor = (raw, paneDialectName) => paneDialectName === "gemini" ? GEMINI : detectDialect(raw);

/** WHAT: Reads the existing dialect-driven tmux activity fallback. WHY: Keeps the agent facade under its cap while preserving screen-only engine observation. */
export function isBusyFromTmux(raw, dialect = detectDialect(raw)) {
  if (dialect.busySignals?.some(signal => typeof signal === "string" ? raw.includes(signal) : signal.test(raw))) return true;
  if (!dialect.idleWhenPromptEmpty) return false;
  const tail = raw.split("\n").map(line => line.trim()).filter(Boolean).slice(-10);
  const prompt = tail.findLast(line => line.startsWith(dialect.promptChar));
  return !prompt || prompt.slice(dialect.promptChar.length).trim().length > 0;
}

const words = text => text.replace(/\s+/gu, "");

// agy wraps the prompt with the same two-space indent as reply text, so only the prompt's own text marks its end.
/** WHAT: Filters agy's echoed prompt from a selected TUI turn and un-indents the reply. WHY: Keeps the wrapped prompt out of the mirrored reply. */
export function geminiReplyTurn(turn, promptText) {
  const lines = turn.split("\n");
  const prompt = words(promptText || "");
  let echoed = "", index = 0;
  for (; index < lines.length && (index === 0 || echoed.length < prompt.length); index++) {
    echoed += words(lines[index].replace(/^> /u, ""));
  }
  if (!prompt || !echoed.startsWith(prompt)) return "";
  return lines.slice(index).map(line => line.replace(/^ {2}/u, "")).join("\n");
}
