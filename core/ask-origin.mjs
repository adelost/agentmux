import { isSystemNoiseDirective } from "./system-noise.mjs";

const AUTOMATION_SOURCES = new Set([
  "auto-compact",
  "amux:compact",
  "dream",
  "drift-guard",
  "suggestions-watchdog",
  "quota-recovery",
  "fleet-restart-recovery",
]);

/** WHAT: Labels who originated a prompt. WHY: `amux asks` defaults to human/operator asks without hiding agent traffic irreversibly. */
export function inferAskOrigin({
  source = "unknown",
  sender = null,
  prompt = "",
} = {}) {
  if (isSystemNoiseDirective(prompt)) return "system";
  if (sender || /^\[from\s+[^\]]+\]/iu.test(String(prompt).trimStart())) return "agent";
  if (source === "discord" || source === "pane-hook") return "human";
  if (AUTOMATION_SOURCES.has(source)) return "system";
  // A plain prompt entered through `amux <agent> ...` outside another pane is
  // an operator ask. Treat it like human input; `[from ...]` handled agents.
  return "human";
}
