// Kimi observed-status truth: the screen tail cannot tell a quiet thinking
// phase from a dead pane ("K3 thinking: max" lingers in scrollback), and the
// generic jsonl-mtime overlay looks in the pane dir while Kimi's Wire lives
// under the Kimi home. Delivery already trusts isBusyFromKimiJsonl, so ps
// consults the same source and the two never disagree.

import { isBusyFromKimiJsonl } from "./kimi-jsonl-reader.mjs";

/** WHAT: Returns the journal-backed status for an idle or unknown Kimi screen read. WHY: Prevents a frozen thinking footer from reading as a dead pane. */
export function kimiObservedStatus(screenStatus, paneDir, options = {}) {
  if (screenStatus !== "idle" && screenStatus !== "unknown") return screenStatus;
  return isBusyFromKimiJsonl(paneDir, options) === true ? "working" : screenStatus;
}
