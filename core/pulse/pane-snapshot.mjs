// WHAT: Shares one tmux pane listing among the bridge's watchers for a short while.
// WHY: Keeps each watcher from asking two process questions per pane per round (docs/DESIGN-pulse.md, pulse-11).

import { createTmuxAdapter } from "../tmux.mjs";
import { isEngineProcess, isShellProcess } from "../tui-stall-recovery.mjs";

/** WHAT: Returns a listing row as paneProcessState answers it. WHY: Keeps both sources in one vocabulary. */
export function processStateOf(row) {
  const command = row?.command ?? null;
  return { command, dead: row?.dead ?? false, shell: isShellProcess(command), running: isEngineProcess(command) };
}

/**
 * WHAT: Builds the shared listing: callers within maxAgeMs get the answer of one list-panes question.
 * WHY: Prevents per-watcher, per-pane process questions while keeping answers at most two seconds old.
 */
export function createPaneSnapshot({ socket, exec, maxAgeMs = 2000, now = () => performance.now(),
  tmux = createTmuxAdapter({ socket, exec }) } = {}) {
  let held = null;
  return {
    panes() {
      if (held && now() - held.at < maxAgeMs) return held.rows;
      const rows = tmux.listAllPanes();
      held = { at: now(), rows };
      rows.catch(() => { if (held?.rows === rows) held = null; });
      return rows;
    },
  };
}
