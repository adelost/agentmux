import { authoredPromptText, isSystemNoiseDirective } from "./system-noise.mjs";

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

/** WHAT: Names the ask sources a person answers through. WHY: Keeps the answer statistic and the search of his words on one list. */
const HUMAN_ASK_SOURCES = new Set(["discord", "pane-hook"]);

/** WHAT: Checks whether a ledger ask is a message a person wrote. WHY: Keeps agents' briefs, wrappers and automation out of everything that counts or quotes his words. */
export function isHumanAsk(ask) {
  return HUMAN_ASK_SOURCES.has(ask?.source)
    && inferAskOrigin({ source: ask.source, sender: ask.sender, prompt: ask.verbatim }) === "human";
}

const OWNER_CHANNELS = new Set(["discord", "voice-pwa"]);

/** WHAT: Checks whether a person sent the job from their own channel. WHY: Lets a pane whose compact failed take its owner's message while automatic work waits. */
export function isOwnerChannelJob(job) {
  return OWNER_CHANNELS.has(job?.source)
    && inferAskOrigin({ source: job.source, sender: job.metadata?.sender, prompt: job.text || "" }) === "human";
}
