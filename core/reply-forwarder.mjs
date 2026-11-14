import { statSync } from "node:fs";
import { extractImageMarkers, validateImagePath } from "../lib.mjs";

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

/** WHAT: Formats one reply and its image attachments. WHY: Keeps provider internals and invalid paths out of mirrored replies. */
export function renderTurn(turn) {
  // Tool calls render as compact semantic labels (`Run ...`, `Edit ...`).
  // Provider wrapper names stay internal so Claude and Codex look alike.
  const items = turn.items || [];
  const hasNarrative = items.some((it) => it.type === "text" && (it.content || "").trim());
  const rawText = items
    // Codex emits write_stdin/wait calls for every background-process poll.
    // The readers classify both legacy and current envelopes semantically.
    .filter((it) => it.kind !== "wait")
    // Cross-agent sends have a stronger, delivery-verified owner in
    // cli/tmux.mjs: target gets the full brief and sender gets an immediate
    // `amux ... → delivered` receipt. Do not repeat the invocation later.
    .filter((it) => it.kind !== "inter-agent-send")
    .map((it) => (it.type === "tool" ? `\`${it.content}\`` : it.content))
    .join("\n\n")
    .trim();
  const { text: cleanedText, paths: imagePaths } = extractImageMarkers(rawText);
  const validFiles = [];
  const failedMarkers = [];
  for (const p of imagePaths) {
    const result = validateImagePath(p, statSync);
    if (result.ok) validFiles.push(result.path);
    else failedMarkers.push(`image skipped: \`${p}\` (${result.error})`);
  }
  const fullText = [cleanedText, ...failedMarkers].filter(Boolean).join("\n\n");
  return { fullText, validFiles, hasNarrative };
}
