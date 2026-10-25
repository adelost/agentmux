import { isHumanAsk, inferAskOrigin } from "./ask-origin.mjs";
import { observedAskOrigin } from "./ask-source-evidence.mjs";

/** WHAT: Checks an original human order channel rather than an engine mirror. WHY: Keeps cron, relays and provider observations out of the C1 population. */
export function onTrackOriginalAsk(ask) {
  return ["discord", "voice-pwa", "discord-voice"].includes(ask.source)
    && observedAskOrigin(ask, inferAskOrigin) === "human" && isHumanAsk({ ...ask, source: "discord" });
}

/** WHAT: Checks declared project panels, terms and actual repository bindings. WHY: Keeps other projects with their own reviewers while retaining the configured project's orders. */
export function onTrackProjectAsk(project, ask, { sameProject = false, otherProject = false } = {}) {
  if (!onTrackOriginalAsk(ask)) return false;
  if (sameProject) return true;
  if (otherProject) return false;
  const panels = project.askPanels;
  const routed = panels ? panels.includes(`${ask.agent}:${ask.pane}`) : project.askAgents.includes(ask.agent);
  const text = String(ask.verbatim || "").normalize("NFKC").toLowerCase();
  return routed || (project.askTerms || []).some(term => text.includes(term.toLowerCase()));
}
