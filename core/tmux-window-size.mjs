// Safe tmux window geometry for detached and interactively attached fleets.

const HEADLESS_WINDOW_COLUMNS = 340;
const HEADLESS_WINDOW_ROWS = 100;

/** WHAT: Normalizes a detached tmux window for tiled agent composers. WHY: Prevents hidden composers in undersized headless panes. */
export async function ensureHeadlessWindow(tmux, name) {
  await tmux.setWindowSizeManual(name).catch(() => {});
  await tmux.resizeWindow(name, HEADLESS_WINDOW_COLUMNS, HEADLESS_WINDOW_ROWS).catch(() => {});
}

/**
 * WHAT: Resolves attached or headless-safe window geometry.
 * WHY: Keeps detached recovery from reusing stale client dimensions.
 */
export async function settleTmuxWindowSize(tmux, name) {
  const attached = await tmux.sessionAttachedCount(name).catch(() => 0);
  if (attached > 0) {
    await tmux.setWindowSizeLatest(name).catch(() => {});
    return;
  }
  await ensureHeadlessWindow(tmux, name);
}
