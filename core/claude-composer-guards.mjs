// Guards that keep amux keystrokes out of Claude's composer at the wrong moment: after a draft amux
// did not type, and while a paste still waits on Claude's clipboard lookup (core/claude-paste-stall.mjs).

import { appendEvent } from "./events.mjs";
import { codexDeliveryBlocked } from "./codex-delivery-blocked.mjs";
import { eraseKeys } from "./delivery-fence.mjs";
import { composerDraft } from "./dialects.mjs";
import { promptRequiresAtomicPaste } from "./prompt-paste.mjs";
import { claudeComposerHoldsPaste, claudeComposerIsPasting, settleClaudePaste } from "./claude-paste-stall.mjs";

/**
 * WHAT: Maps Claude's held or landed paste of this prompt to a delivery transport state, or null.
 * WHY: Keeps a held paste from reading as an idle empty composer that invites restart or compact.
 */
export function claudePasteTransportState(screen, prompt) {
  if (claudeComposerIsPasting(screen)) return "pasting";
  return promptRequiresAtomicPaste(prompt) && claudeComposerHoldsPaste(screen, prompt) ? "drafted" : null;
}

function recordLookupEnded(agentName, pane, released, scripts) {
  console.warn(`send ${agentName}:${pane}: Claude paste waited on its clipboard lookup; ended pids ${released.join(", ")}`);
  try {
    appendEvent({
      ts: new Date().toISOString(),
      event: "claude_clipboard_lookup_ended",
      session: agentName,
      pane: Number(pane) || 0,
      pids: released,
      detail: scripts.join(" | ").slice(0, 160),
    });
  } catch (error) { console.warn(`claude_clipboard_lookup_ended event failed: ${error.message}`); }
}

/**
 * WHAT: Builds the Claude composer guards one agent transport runs before it types or presses Enter.
 * WHY: Keeps amux keystrokes out of human drafts and out of a paste Claude still holds.
 */
export function createClaudeComposerGuards({ capture, panePid, sendLiteral, sendKeys, wait }) {
  /** Waits a bounded time for Claude's paste handler; maintenance only reports, delivery may end the lookup. */
  function settlePaste(agentName, pane, { maintenance = false } = {}) {
    return settleClaudePaste({
      capture: () => capture(agentName, pane),
      panePid: () => panePid(agentName, pane),
      wait,
      mayRelease: !maintenance,
      onReleased: ({ released, scripts }) => recordLookupEnded(agentName, pane, released, scripts),
    });
  }

  /** Refuses to type or press Enter while Claude is still pasting: both would be swallowed by the held paste. */
  async function requireSettledPaste(agentName, pane, { maintenance }) {
    const settled = await settlePaste(agentName, pane, { maintenance });
    if (!settled.ok) throw codexDeliveryBlocked(`Claude prompt delivery blocked: ${settled.reason}`);
  }

  /**
   * Refuses to type while Claude's composer holds text amux did not write, and leaves that text as it was.
   * Typing appends to the draft, so "/compact/compact" turned Mattias's question into
   * "/compact/compact[…] Hej, var är ni någonstans?" (lsrc:1, 2026-09-28). A suggestion in the box
   * disappears on the first keystroke and a draft does not, so one probe space tells them apart and is erased.
   */
  async function refuseToTypeAfterDraft(agentName, pane, target) {
    if (!composerDraft(await capture(agentName, pane))) return;
    await sendLiteral(target, " ");
    await wait(300);
    const draft = composerDraft(await capture(agentName, pane));
    await sendKeys(target, eraseKeys(" "));
    if (draft === "") return;
    throw codexDeliveryBlocked(
      `Claude prompt delivery blocked: the composer holds a draft amux did not type ("${String(draft).slice(0, 40)}")`,
    );
  }

  return { settlePaste, requireSettledPaste, refuseToTypeAfterDraft };
}
