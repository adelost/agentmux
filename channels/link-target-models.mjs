// Link target model projection. It reads the same pane evidence as `amux ps`;
// no target is started, resumed, prompted or asked to identify itself.

import { inspectPane } from "../cli/inspect-pane.mjs";
import { paneModelSelection } from "../core/pane-model-state.mjs";

const modelValue = (value) => {
  const model = String(value?.model || "").trim();
  if (!model) return null;
  const effort = String(value?.effort || "").trim().toLowerCase();
  return { model, effort: effort || null };
};

/**
 * WHAT: Returns one pane model qualified against its current session.
 * WHY: Prevents previous-session evidence from appearing current.
 */
export function qualifyLinkPaneModel({
  running,
  currentSessionId,
  observed,
  previousObserved = null,
  configured = null,
} = {}) {
  const exactObserved = modelValue(observed);
  const previous = modelValue(previousObserved);
  const observedSessionId = String(observed?.sessionId || "").trim();
  const current = String(currentSessionId || "").trim();
  const exactSession = running === true && current && observedSessionId === current;
  const visibleObserved = exactObserved || previous;
  return {
    status: exactSession && exactObserved ? "current" : visibleObserved ? "stale" : "unknown",
    observed: visibleObserved,
    configured: modelValue(configured),
  };
}

/**
 * WHAT: Reads Link's mapped panes through the existing pane inspector.
 * WHY: Keeps status reads separate from pane wake and model execution.
 */
export async function observeLinkTargetModels({
  targets,
  agents,
  agent,
  state,
  inspect = inspectPane,
} = {}) {
  const fleet = new Map((agents || []).map((entry) => [entry.name, entry]));
  const entries = await Promise.all((targets || []).map(async (target) => {
    const address = String(target?.id || "").match(/^([a-z][a-z0-9_-]{0,31}):(\d{1,3})$/u);
    const name = String(target?.agent || address?.[1] || "");
    const pane = Number.isInteger(target?.pane) ? target.pane : Number(address?.[2]);
    const configuredAgent = fleet.get(name);
    if (!configuredAgent || !Number.isSafeInteger(pane) || pane < 0) return [target?.id, null];
    try {
      const process = configuredAgent.backend === "native"
        ? { index: pane, command: "native", dead: false }
        : { index: pane, ...await agent.paneProcessState(name, pane) };
      const reading = await inspect({ agent, state }, configuredAgent, process);
      return [target.id, qualifyLinkPaneModel({
        running: reading.modelView?.running,
        currentSessionId: reading.modelView?.currentSessionId,
        observed: reading.modelView?.observed,
        previousObserved: paneModelSelection(state, name, pane),
        configured: reading.modelView?.configured,
      })];
    } catch {
      return [target.id, qualifyLinkPaneModel({
        running: false,
        previousObserved: paneModelSelection(state, name, pane),
      })];
    }
  }));
  return new Map(entries.filter(([id, model]) => id && model));
}

/** WHAT: Builds targets with available model evidence. WHY: Keeps private and public transport projection identical. */
export function targetsWithModels(targets, models) {
  return (targets || []).map((target) => {
    if (!models?.has?.(target.id)) return { ...target };
    return { ...target, model: models.get(target.id) };
  });
}
