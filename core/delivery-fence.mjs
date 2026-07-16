// Tiny pure fences shared by the durable queue and pane transport.

/**
 * WHAT: Checks whether a durable prompt may be pasted into the composer.
 * WHY: Prevents a vanished draft from becoming permission to duplicate text.
 */
export function shouldPastePrompt({ knownDrafted = false, alreadyComposed = false } = {}) {
  return !knownDrafted && !alreadyComposed;
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
