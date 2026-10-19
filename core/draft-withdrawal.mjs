// Withdraws the text a cancelled delivery typed into a pane composer, and only that text.
//
// A cancelled delivery either clears its own draft or is submitted (lsrc:0, 2026-10-19: a quota-recovery text sat in
// claw:2's composer until a person pressed Enter). Text amux cannot prove is its own is never cleared
// (claude-composer-guards.mjs, 2026-09-28). Every key therefore waits for a composer that reads exactly like the
// text amux typed, on an idle pane: two Escapes clear a nonempty Claude draft, but on an empty composer they open the
// rewind menu and on a busy pane they interrupt the turn.
//
// A withdrawal ends in one of five outcomes:
//   absent        the composer is empty, so there is nothing to clear (no key is sent)
//   cleared       the composer held exactly the text, the clear keys were sent, an empty composer was seen
//   foreign       the composer holds anything else: a person's words, a collapsed paste, another message
//   unreadable    an engine whose composer amux does not read; nothing is sent
//   unobservable  the pane is busy, Claude still pastes, the composer is hidden, or a capture or key failed

import { rewriteModelSlash } from "./claude-model.mjs";
import { clearCodexComposerDraft, codexComposerText } from "./codex-tui.mjs";
import { COMPOSER_LINE_RE, composerLines } from "./dialects.mjs";

// The clear keys get about half a second to show on screen: one look at once, then five more 100 ms apart.
const VERIFY_LOOKS_AFTER_KEYS = 5;
const VERIFY_LOOK_MS = 100;

/** Claude's whole composer text, continuation rows included; composerDraft keeps only the first row. */
function claudeComposerText(screen) {
  const rows = composerLines(screen);
  const start = rows.findIndex((row) => COMPOSER_LINE_RE.test(row));
  return start < 0 ? null : [rows[start].replace(COMPOSER_LINE_RE, ""), ...rows.slice(start + 1)].join("\n");
}

// The engines whose composer amux reads reliably, each with how it clears a nonempty draft. Claude clears all rows
// with two Escapes. A Codex clear-line pass deletes one logical row, so its own multi-pass routine runs until empty.
const ENGINES = {
  claude: {
    read: claudeComposerText,
    clear: async ({ agent, agentName, pane }) => {
      await agent.sendEscape(agentName, pane);
      await agent.sendEscape(agentName, pane);
    },
  },
  codex: {
    read: codexComposerText,
    clear: async ({ agent, agentName, pane, wait }) => {
      const cleared = await clearCodexComposerDraft({
        capture: () => agent.captureScreen(agentName, pane),
        clear: () => agent.clearInputLine(agentName, pane),
        sleep: wait,
      });
      if (!cleared.ok) throw new Error(cleared.error);
    },
  },
};

const withoutWhitespace = (text) => String(text).replace(/\s+/gu, "");
const outcome = (name, detail = null) => ({ outcome: name, detail });
const waiting = (detail) => outcome("unobservable", detail);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * WHAT: Compares a cancelled job's text with the composer and clears an exact match.
 * WHY: Keeps a cancelled draft out of an unsubmitted composer without erasing text amux cannot prove is its own.
 */
export async function withdrawDraft({ agent, job, wait = sleep }) {
  const { agentName, pane } = job;
  // What amux typed is the text after the model rewrite that deliverToPane applies.
  const typed = rewriteModelSlash(job.text);

  let transport;
  try { transport = await agent.promptTransportState(agentName, pane, typed); }
  catch (error) { return waiting(`pane state unreadable: ${error.message}`); }
  if (transport.state === "pasting") return waiting("Claude is still pasting");
  const engine = ENGINES[transport.dialect];
  if (!engine) return outcome("unreadable", `${transport.dialect || "unknown"} composer`);

  const composerNow = async () => engine.read(await agent.captureScreen(agentName, pane));
  let composer;
  try { composer = await composerNow(); }
  catch (error) { return waiting(`pane capture failed: ${error.message}`); }
  if (composer === null) return waiting("composer is not visible");
  if (composer.trim() === "") return outcome("absent");
  if (withoutWhitespace(composer) !== withoutWhitespace(typed)) return outcome("foreign");
  if (transport.busy) return waiting("pane busy");

  try {
    await engine.clear({ agent, agentName, pane, wait });
    for (let look = 0; look <= VERIFY_LOOKS_AFTER_KEYS; look += 1) {
      if (look > 0) await wait(VERIFY_LOOK_MS);
      if ((await composerNow())?.trim() === "") return outcome("cleared");
    }
  } catch (error) { return waiting(`clear failed: ${error.message}`); }
  return waiting("clear keys sent but the composer did not read empty within 500 ms");
}
