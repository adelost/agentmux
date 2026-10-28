// Link target model projection. It reads the same pane evidence as `amux ps`;
// no target is started, resumed, prompted or asked to identify itself.

import { inspectPane } from "../cli/inspect-pane.mjs";
import { paneModelSelection } from "../core/pane-model-state.mjs";
import { codexModelOverride } from "../core/codex-profiles.mjs";
import { panePathFor } from "../core/jsonl-reader.mjs";
import { sessionReaderForCommand } from "../core/alternate-session-reader.mjs";

// A model change that moves neither the pane's process nor its journal still shows within this long.
const RECHECK_MS = 5 * 60_000;

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
  paneProcess = (name, pane) => agent.paneProcessState(name, pane),
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
        : { index: pane, ...await paneProcess(name, pane) };
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

/** WHAT: Returns a pane's journal stamps as inspectPane reads them. WHY: Keeps the reuse rule on the same files. */
export function paneJournalStamp(configured, pane) {
  return sessionReaderForCommand(configured.panes?.[pane]?.cmd || "").latestInfo(panePathFor(configured, pane));
}

/**
 * WHAT: Builds Link's model reader that inspects a pane again only after its inputs change.
 * WHY: Prevents idle panes from costing a capture and two tmux questions every 15 s (pulse-9).
 */
export function createLinkTargetModels({
  agents, agent, state, fleetPanes, inspect = inspectPane, journalStamp = paneJournalStamp, now = Date.now,
} = {}) {
  const readings = new Map();
  return async (targets) => {
    const rows = await fleetPanes.panes();
    const paneProcess = (name, pane) => {
      const row = rows.get(`${name}:${pane}`);
      return { command: row?.command ?? null, dead: row?.dead ?? false, pid: row?.pid ?? null };
    };
    const reuse = async (ctx, configured, process) => {
      const key = `${configured.name}:${process.index}`;
      const stamp = JSON.stringify([process.dead, process.command, process.pid, journalStamp(configured, process.index),
        configured.panes?.[process.index], configured.claudeModel, configured.codexModel,
        codexModelOverride(state, configured.name, process.index)]);
      const held = readings.get(key);
      if (held?.stamp === stamp && now() - held.at < RECHECK_MS) return held.reading;
      const reading = await inspect(ctx, configured, process);
      readings.set(key, { stamp, at: now(), reading });
      return reading;
    };
    return observeLinkTargetModels({ targets, agents: agents(), agent, state, inspect: reuse, paneProcess });
  };
}

/** WHAT: Builds targets with available model evidence. WHY: Keeps private and public transport projection identical. */
export function targetsWithModels(targets, models) {
  return (targets || []).map((target) => {
    if (!models?.has?.(target.id)) return { ...target };
    return { ...target, model: models.get(target.id) };
  });
}
