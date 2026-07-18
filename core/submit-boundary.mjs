// Shared recovery order for authoritative Claude and Codex turn boundaries.

import { recoverCompactedClaudeSubmit } from "./claude-submit-boundary.mjs";
import { recoverClosedCodexSubmit } from "./codex-submit-boundary.mjs";

/** WHAT: Routes one submit superseded by an authoritative session boundary. WHY: Keeps dialect policy outside the FIFO writer. */
export async function recoverSupersededSubmit(options) {
  const compacted = await recoverCompactedClaudeSubmit({ ...options,
    onRecovered: (value) => options.onRecovered(value, "submit_superseded_by_compact") });
  if (compacted) return compacted;
  return recoverClosedCodexSubmit({ ...options,
    onRecovered: (value) => options.onRecovered(value, "submit_superseded_by_codex_boundary") });
}
