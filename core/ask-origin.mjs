import { authoredPromptText, isSystemNoiseDirective } from "./system-noise.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";

const AUTOMATION_SOURCES = new Set([
  "auto-compact",
  "amux:compact",
  "dream",
  "drift-guard",
  "suggestions-watchdog",
  "quota-recovery",
  "codex-capacity-recovery",
  "codex-limit-recovery",
  "fleet-restart-recovery",
]);

/** WHAT: Labels who originated a prompt. WHY: `amux asks` defaults to human/operator asks without hiding agent traffic irreversibly. */
export function inferAskOrigin({
  source = "unknown",
  sender = null,
  prompt = "",
} = {}) {
  if (isSystemNoiseDirective(prompt)) return "system";
  if (sender || /^\[from\s+[^\]]+\]/iu.test(authoredPromptText(prompt))) return "agent";
  if (source === "discord" || source === "pane-hook") return "human";
  if (AUTOMATION_SOURCES.has(source)) return "system";
  // A plain prompt entered through `amux <agent> ...` outside another pane is
  // an operator ask. Treat it like human input; `[from ...]` handled agents.
  return "human";
}

const OWNER_CHANNELS = new Set(["discord", "voice-pwa"]);

/** WHAT: Checks whether a person sent the job from their own channel. WHY: Lets a pane whose compact failed take its owner's message while automatic work waits. */
export function isOwnerChannelJob(job) {
  return OWNER_CHANNELS.has(job?.source)
    && inferAskOrigin({ source: job.source, sender: job.metadata?.sender, prompt: job.text || "" }) === "human";
}

/** WHAT: Checks whether the owner's message is this job or waits behind it. WHY: Prevents a held automatic head of the FIFO from locking the owner out. */
export function ownerMessageWaiting(queue, job) {
  return isOwnerChannelJob(job) || Boolean(queue?.list?.(job.agentName, job.pane)
    ?.some(other => !TERMINAL_DELIVERY_STATES.has(other.status) && isOwnerChannelJob(other)));
}
