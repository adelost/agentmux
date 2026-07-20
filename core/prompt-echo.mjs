// Prompt-echo verification across engine dialects.
//
// Source of truth: the agent's own session jsonl. When the user prompt
// appears there, we know for certain the agent received it. No tmux pane
// width tricks, no wordwrap to fight, and no generic busy signal pretending
// that unrelated keystrokes were accepted.

/** WHAT: Builds the dialect-dispatching prompt-echo check over the journal readers. WHY: Keeps receipt semantics out of the agent facade. */
export function createPromptEcho({
  paneDir,
  agentConfig,
  paneDialectName,
  isPromptInJsonl,
  isPromptInCodexJsonl,
  kimiJournal,
  wait,
}) {
  /** WHAT: Checks the journal for the exact prompt until timeout. WHY: Prevents screen echoes from becoming delivery receipts. */
  return async function waitForPromptEcho(agentName, pane, promptText, timeoutMs = 15000, {
    notBeforeMs = 0,
    cursor = null,
  } = {}) {
    const needle = promptText?.trim();
    if (!needle) return true;

    const dir = paneDir(agentConfig(agentName).dir, pane);
    const dialect = paneDialectName(agentName, pane);

    const deadline = Date.now() + Math.max(0, timeoutMs);
    // Always inspect once. A zero-timeout check is used by durable Discord
    // replay to prove that an earlier attempt eventually reached JSONL before
    // it considers typing the same message again.
    while (true) {
      // Try jsonl first (width-independent, reliable)
      let found = null;
      if (dialect === "claude") found = isPromptInJsonl(dir, promptText, { notBeforeMs, cursor });
      else if (dialect === "codex") {
        found = isPromptInCodexJsonl(dir, promptText, { notBeforeMs, cursor });
      } else if (dialect === "kimi") {
        // Cursor-scoped receipts may accept Kimi's collapsed `[paste #…]`
        // marker; the FIFO makes this job's paste the only one possible there.
        found = kimiJournal.promptAccepted(dir, promptText, {
          notBeforeMs, cursor, allowPastePlaceholder: Boolean(cursor),
        });
      }
      if (found === true) return true;

      if (Date.now() >= deadline) break;
      await wait(200);
    }
    return false;
  };
}
