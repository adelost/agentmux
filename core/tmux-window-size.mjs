// Fixed tmux window geometry for the fleet: manual 340x100 whether or not a client is attached.
//
// Re-tiling rule (row 52): a detached session is re-tiled at every settle, which also heals a zoom a crashed
// delivery left behind. An attached session is re-tiled only when the pin changed its window's size (120x29 back
// to 340x100): a window already 340x100 keeps the person's zoom and pane sizes, which select-layout would reset.

const HEADLESS_WINDOW_COLUMNS = 340;
const HEADLESS_WINDOW_ROWS = 100;

const isFleetSize = (size) => size?.columns === HEADLESS_WINDOW_COLUMNS && size?.rows === HEADLESS_WINDOW_ROWS;

/**
 * WHAT: Normalizes a tmux window to the fleet's fixed manual size, reporting whether the size changed.
 * WHY: Keeps an attached client from resizing the fleet's panes; an unreadable size counts as changed.
 */
export async function ensureHeadlessWindow(tmux, name) {
  const before = await tmux.windowSize(name).catch(() => null);
  await tmux.setWindowSizeManual(name).catch(() => {});
  await tmux.resizeWindow(name, HEADLESS_WINDOW_COLUMNS, HEADLESS_WINDOW_ROWS).catch(() => {});
  return !isFleetSize(before);
}

/**
 * WHAT: Normalizes a session's window to manual 340x100 and says whether to re-apply the layout.
 * WHY: Keeps a viewer's zoom: detached sessions re-tile at every settle, attached ones only when the pin resized.
 */
export async function settleTmuxWindowSize(tmux, name) {
  const sizeChanged = await ensureHeadlessWindow(tmux, name);
  const attached = await tmux.sessionAttachedCount(name).catch(() => 0);
  return attached > 0 ? sizeChanged : true;
}
