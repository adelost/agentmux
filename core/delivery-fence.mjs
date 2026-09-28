// Tiny pure fences shared by the durable queue and pane transport.

/**
 * WHAT: Checks whether a durable prompt may be pasted into the composer.
 * WHY: Prevents a vanished draft from becoming permission to duplicate text.
 */
export function shouldPastePrompt({ knownDrafted = false, alreadyComposed = false } = {}) {
  return !knownDrafted && !alreadyComposed;
}

/** WHAT: Builds tmux keys that delete text just typed at the cursor. WHY: Keeps a refused command from staying in the composer. */
export function eraseKeys(text) {
  return Array.from({ length: [...String(text)].length }, () => "BSpace").join(" ");
}

/**
 * WHAT: Runs the last maintenance check before Enter and erases the command typed in this attempt when it refuses.
 * WHY: Prevents unattended maintenance from leaving its own text for the next message to be typed after
 *   (lsrc:1, 2026-09-28: Mattias's question went out as "/compact/compact[…] Hej, var är ni någonstans?").
 */
export async function submitCheckOrErase(check, erase = null) {
  try {
    await check("submit");
  } catch (error) {
    if (erase) await erase().catch((eraseError) => { error.message += `; typed command not erased: ${eraseError.message}`; });
    throw error;
  }
}

/**
 * WHAT: Stores ambiguity before the physical submit key can leave the process.
 * WHY: Keeps crashes after Enter from reopening an at-most-once delivery.
 */
export async function submitWithDurableFence({ onSubmitting = null, sendEnter, onSubmitted = null }) {
  if (typeof sendEnter !== "function") throw new Error("submit fence requires sendEnter");
  if (onSubmitting) await onSubmitting();
  await sendEnter();
  if (onSubmitted) await onSubmitted();
}
