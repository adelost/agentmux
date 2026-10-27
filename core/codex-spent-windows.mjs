// The account snapshot is read at most every 15 minutes (QUOTA_REFRESH_INTERVAL_MS); a running turn's journal shows a spent
// window with its next model call. The credit guard records what it saw, and the floor reads it beside the snapshot.

/** WHAT: Stores the spent windows a pane's journal showed, per pane and account. WHY: Keeps the floor ahead of the 15-minute snapshot. */
export function createSpentWindows() {
  const byPane = new Map();
  return {
    record(paneKey, { accountKey, window, resetsAt }) {
      const rest = (byPane.get(paneKey) || []).filter(entry => !(entry.accountKey === accountKey && entry.window === window));
      byPane.set(paneKey, [...rest, { accountKey, window, resetsAt }]);
    },
    forPane: paneKey => byPane.get(paneKey) || [],
  };
}

/**
 * WHAT: Returns an account reading with the windows a journal showed spent.
 * WHY: Keeps the floor from reading 97 % of a window the journal shows spent.
 */
export function overlaySpentWindows(facts, records, now) {
  const live = (records || []).filter(entry => entry.resetsAt > now && entry.accountKey === facts?.account?.key);
  if (!facts?.windows || !live.length) return facts;
  const windows = [...facts.windows];
  for (const { window, resetsAt } of live) {
    const spent = { kind: window, usedPercent: 100, resetsAt: new Date(resetsAt).toISOString() };
    const at = windows.findIndex(entry => entry.kind === window);
    if (at < 0) windows.push(spent);
    else windows[at] = { ...windows[at], ...spent };
  }
  return { ...facts, windows };
}

/** WHAT: Wraps a pane's account reader so every consumer sees the journal's spent windows. WHY: Keeps the floor, the credit hold and the park on one reading. */
export const withSpentWindows = (read, spentWindows, now = Date.now) =>
  async (paneKey, options) => overlaySpentWindows(await read(paneKey, options), spentWindows.forPane(paneKey), now());
