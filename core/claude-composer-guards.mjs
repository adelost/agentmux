// Guards that keep amux keystrokes out of Claude's composer at the wrong moment: after a draft amux
// did not type, and while a paste still waits on Claude's clipboard lookup (core/claude-paste-stall.mjs).

import { appendEvent } from "./events.mjs";
import { codexDeliveryBlocked } from "./codex-delivery-blocked.mjs";
import { eraseKeys } from "./delivery-fence.mjs";
import { composerDraft } from "./dialects.mjs";
import { claudeComposerHasCollapsedPaste, claudeComposerIsPasting, holdsOwnCollapsedPaste, ownCollapsedPaste, paneClaudeProcess,
  settleClaudePaste } from "./claude-paste-stall.mjs";

export { claudeSafePasteParts } from "./claude-paste-stall.mjs";

/**
 * WHAT: Maps Claude's held paste to "pasting" and a collapsed paste to "foreign", or returns null.
 * WHY: Keeps either from reading as an idle empty composer or as amux's own draft.
 */
export function claudePasteTransportState(screen) {
  if (claudeComposerIsPasting(screen)) return "pasting";
  return claudeComposerHasCollapsedPaste(screen) ? "foreign" : null;
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

  const claudeProcess = async (agentName, pane) => paneClaudeProcess(await panePid(agentName, pane));

  /** Reads the collapsed paste amux's own paste just left in the composer; null when Claude showed the text itself. */
  async function recordOwnPaste(agentName, pane) {
    return ownCollapsedPaste(await capture(agentName, pane), await claudeProcess(agentName, pane));
  }

  /**
   * A paste waiting on Claude's clipboard lookup shows an empty composer; it is neither idle nor empty. A collapsed
   * paste is a person's unless it is exactly the one this job's own paste left, in the same Claude process.
   */
  async function pasteTransport(agentName, pane, ownedPaste = null) {
    const screen = await capture(agentName, pane).catch(() => "");
    const state = claudePasteTransportState(screen);
    if (state === "foreign" && ownedPaste && holdsOwnCollapsedPaste(screen, await claudeProcess(agentName, pane), ownedPaste)) {
      return { state: "drafted", detail: "amux's own collapsed paste" };
    }
    return state && { state, detail: state === "pasting" ? "Pasting…" : "a collapsed paste amux cannot attribute" };
  }

  /** Checks that the composer still holds exactly that paste, in the same Claude process. */
  async function holdsOwnPaste(agentName, pane, owned) {
    if (!owned) return false;
    return holdsOwnCollapsedPaste(await capture(agentName, pane), await claudeProcess(agentName, pane), owned);
  }

  return { settlePaste, requireSettledPaste, refuseToTypeAfterDraft, recordOwnPaste, holdsOwnPaste, pasteTransport };
}
