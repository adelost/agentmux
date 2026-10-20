// Fixed tmux window geometry for the fleet: manual 340x100 whether or not a client is attached.

const HEADLESS_WINDOW_COLUMNS = 340;
const HEADLESS_WINDOW_ROWS = 100;

/**
 * WHAT: Normalizes a tmux window to the fleet's fixed manual size.
 * WHY: Keeps an attached client from resizing the fleet's panes; it views the window instead.
 */
export async function ensureHeadlessWindow(tmux, name) {
  await tmux.setWindowSizeManual(name).catch(() => {});
  await tmux.resizeWindow(name, HEADLESS_WINDOW_COLUMNS, HEADLESS_WINDOW_ROWS).catch(() => {});
}

/**
 * WHAT: Normalizes a session's window to manual 340x100, attached or not.
 * WHY: Keeps an attached client from resizing the fleet's panes; true tells callers to re-apply their layout.
 */
export async function settleTmuxWindowSize(tmux, name) {
  await ensureHeadlessWindow(tmux, name);
  return true;
}
