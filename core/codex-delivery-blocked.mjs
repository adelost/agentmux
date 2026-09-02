// The one error shape the durable broker recognises as "do not retry by
// typing again". Built here so every Codex refusal carries the same code,
// the same recovery flag and the same honest wording.

import { describeNonEmptyComposer } from "./codex-vocabulary.mjs";

const DELIVERY_BLOCKED_CODE = "AMUX_DELIVERY_BLOCKED";

/** WHAT: Builds the delivery-blocked error with its recovery flag. WHY: Keeps the broker's retry decision from parsing message text. */
export function codexDeliveryBlocked(message, { zoomRecoverable = false } = {}) {
  const error = new Error(message);
  error.code = DELIVERY_BLOCKED_CODE;
  if (zoomRecoverable) error.zoomRecoverable = true;
  return error;
}

// Zoom-recoverable: narrow-pane Ratatui wraps can make placeholder chrome
// read as a draft; the one zoomed retry re-reads at canonical width, where a
// REAL draft still blocks.
/** WHAT: Builds the delivery-blocked error for a composer holding foreign text. WHY: Keeps every refusal from omitting the vocabulary drift note. */
export async function blockedByNonEmptyComposer(agent, composer, { head } = {}) {
  const reason = await describeNonEmptyComposer(agent, composer, { head });
  return codexDeliveryBlocked(`Codex prompt delivery blocked: ${reason}`, { zoomRecoverable: true });
}
