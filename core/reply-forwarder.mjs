// Narrow reply filter used by the single JSONL watcher. The old CLI reply
// forwarder was removed because it raced the watcher and duplicated posts.

/**
 * Claude Code's literal reply to harness-injected notification turns
 * (a background task that died with the previous session, resume
 * bookkeeping). This is the HARNESS speaking, not the agent — mirroring it
 * to Discord reads as the agent refusing to answer (observed #api-1
 * 2026-07-08, right after a WSL reboot: "kör..." → "No response
 * requested." while the real reply followed a minute later).
 *
 * "ok"/"läst"/"kvitterat" are real agent acknowledgements and must keep
 * mirroring; only the exact harness placeholder is noise everywhere.
 */
export const isHarnessPlaceholder = (text) =>
  /^no response requested\.?$/i.test((text || "").trim());
