// Pure prompt and launch shapes shared by native Claude/Codex turns.

import { CLAUDE_AUTONOMOUS_ARGS } from "../../core/execution-safety.mjs";

/** WHAT: Formats local attachment paths into one engine prompt. WHY: Keeps upload references explicit across engines. */
export const attachmentPrompt = (prompt, attachments) => attachments.reduce((text, attachment) => {
  const label = attachment.image ? "Attached image" : "Attached file";
  return `${text}\n[${label}: ${attachment.path}]`;
}, prompt);

/**
 * WHAT: Builds one long-lived native Claude CLI launch.
 * WHY: Keeps resume in process recovery and out of per-turn transport.
 */
export function buildNativeClaudeLaunch({ command, agent, rawPrompt, attachments, settings }) {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", settings.model,
    "--effort", settings.effort,
    "--name", agent.name,
  ];
  if (agent.permissionMode === "automation") args.push(...CLAUDE_AUTONOMOUS_ARGS);
  else args.push("--permission-mode", "acceptEdits");
  if (agent.sessionId) args.push("--resume", agent.sessionId);
  return { command, args, prompt: attachmentPrompt(rawPrompt, attachments) };
}

/** WHAT: Builds native Codex input blocks. WHY: Keeps images typed while ordinary files remain explicit prompt paths. */
export function buildNativeCodexInput(rawPrompt, attachments) {
  const images = attachments.filter((attachment) => attachment.image);
  const otherFiles = attachments.filter((attachment) => !attachment.image);
  return [
    { type: "text", text: attachmentPrompt(rawPrompt, otherFiles) },
    ...images.map((image) => ({ type: "localImage", path: image.path })),
  ];
}
