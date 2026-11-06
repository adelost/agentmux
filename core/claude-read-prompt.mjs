// Whether a Claude pane recorded any typed prompt after a delivery cursor, whatever its words.
// The FIFO types one job at a time, so an idle pane with such a record read that job even when Claude
// rewrote its text past the exact matcher (job 1abd84aa to sandman:0, 2026-11-06).

import { claudeProjectDir } from "./claude-paths.mjs";
import { extractPromptFromEvent } from "./claude-prompt-text.mjs";
import { isClaudeTaskNotification } from "./claude-turn-lifecycle.mjs";
import { createJsonlReceiptProbe } from "./jsonl-append-cursor.mjs";
import { CLAUDE_PROMPT_CURSOR_KIND, listJsonlFiles } from "./jsonl-reader.mjs";

const anyPromptReceipt = createJsonlReceiptProbe();
// Claude's own records that are not typed input: local slash-command echoes and an interruption marker.
const CLAUDE_OWN_INPUT_RE = /^(?:<(?:command-name|command-message|local-command-stdout|local-command-caveat)>|\[Request interrupted by user)/u;

/** WHAT: Checks one event for typed input of any text. WHY: Separates a prompt Claude read from its own meta, task and command records. */
function recordsTypedPrompt(event) {
  if (event?.isMeta || isClaudeTaskNotification(event)) return false;
  const text = extractPromptFromEvent(event)?.trim();
  return Boolean(text) && !CLAUDE_OWN_INPUT_RE.test(text);
}

/** WHAT: Checks whether Claude recorded any typed prompt after a delivery cursor. WHY: Separates a reworded read prompt from a pane that never ingested. */
export function isAnyPromptInJsonlAfterCursor(paneDir, cursor) {
  if (cursor?.kind !== CLAUDE_PROMPT_CURSOR_KIND) return false;
  const files = listJsonlFiles(claudeProjectDir(paneDir)).map(({ path }) => path);
  return anyPromptReceipt(files, cursor, "any-typed-prompt", recordsTypedPrompt);
}
