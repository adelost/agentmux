// Model evidence is independent of context usage and never implies a live process.
import { shortModelName } from "../core/context.mjs";
import { isLiveStatus, needsHumanStatus, statusTier } from "../core/pane-status.mjs";

const label = (value) => value?.model
  ? shortModelName(value.model) + (value.effort ? `·${value.effort}` : "") : null;

/** WHAT: Formats selected and last-observed models with process state. WHY: Prevents old rollouts from masquerading as a running model after exit or a switch. */
export function formatPaneModel(pane) {
  const view = pane.modelView;
  if (!view) return pane.command;
  const selected = label(view.selected);
  const observed = label(view.observed);
  const parts = [];
  if (view.running === false) parts.push("stopped");
  if (selected) parts.push(`${selected} [${view.selected.source === "override" ? "configured" : "selected"}]`);
  if (observed && (observed !== selected || view.running !== true)) parts.push(`last: ${observed}`);
  return parts.join("; ") || pane.command;
}

/** WHAT: Checks whether model evidence warrants an expanded pane row. WHY: Prevents missing context from hiding model evidence at idle. */
export function shouldExpandPane(pane) {
  return isLiveStatus(pane.status) || needsHumanStatus(pane.status) || statusTier(pane.status) >= 2
    || Number.isFinite(pane.context?.percent)
    || Boolean(pane.modelView?.observed?.model || pane.modelView?.selected?.model);
}
