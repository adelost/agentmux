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

// lsrc:1, 2026-09-28: maintenance typed /compact and its last check refused Enter, so the text stayed and Mattias's
// question went out as "/compact/compact[…] Hej, var är ni någonstans?". A delivery its sender cancelled is erased
// the same way. `erasesFor` names the refusals that erase; any other refusal keeps the draft for the next attempt.
/**
 * WHAT: Checks the submit fence and erases this attempt's typed text when the check refuses.
 * WHY: Prevents a refused attempt from leaving its own text for the next message to be typed after.
 */
export async function submitCheckOrErase(check, erase = null, erasesFor = () => true) {
  try {
    await check("submit");
  } catch (error) {
    if (erase && erasesFor(error)) await erase().catch((eraseError) => { error.message += `; typed command not erased: ${eraseError.message}`; });
    throw error;
  }
}

/** WHAT: Names the error code of a delivery whose sender asked to cancel it. WHY: Keeps the broker, the pane transport and their tests on one code. */
export const DELIVERY_CANCEL_REQUESTED = "AMUX_DELIVERY_CANCEL_REQUESTED";

/** WHAT: Checks whether an error is the sender's cancellation refusal. WHY: Lets the transport erase its own typed text for a cancel and keep it for every other refusal. */
export const isDeliveryCancelRequested = (error) => error?.code === DELIVERY_CANCEL_REQUESTED;

/**
 * WHAT: Checks a delivery job for a standing cancellation request and throws the shared cancellation error.
 * WHY: Keeps a cancelled job from being typed or submitted at any stage before Enter, through one error.
 */
export function throwIfCancelRequested(job, stage) {
  if (job?.cancelRequestStatus !== "requested") return;
  const error = new Error(`delivery cancellation requested before ${stage}`);
  error.code = DELIVERY_CANCEL_REQUESTED;
  throw error;
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
