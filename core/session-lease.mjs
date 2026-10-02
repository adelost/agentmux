// All panes of one agent share a tmux window and zoom is window-global, so
// two independent pane deliveries can hide each other's composers. Every TUI
// write is therefore single-writer per session, across duplicate bridge
// processes too. A pane fence can outlive that write while the engine works
// on a command we sent, such as a compact: its siblings are served again
// while that one pane stays exclusive.
// On 2026-10-02 lsrc:3's compact held the whole lsrc session for 3.5 minutes,
// so lsrc:2's warned compact was refused and ran cold 42 minutes later.

/**
 * WHAT: Builds one session write lease that also fences one pane or every pane.
 * WHY: Keeps a long engine-side wait from blocking sibling panes of the session.
 */
export function acquireSessionWriteLease({ session, paneFence, fencedPanes }, pane = null) {
  const sessionLease = session();
  if (!sessionLease) return null;
  // Without a pane the caller acts on the whole session (sleep, rotation,
  // model change) and must wait for every fenced pane, as it did before.
  const fences = [];
  for (const target of pane == null ? fencedPanes() : [pane]) {
    const fence = paneFence(target);
    if (!fence) {
      for (const held of fences) held.release();
      sessionLease.release();
      return null;
    }
    fences.push(fence);
  }
  let held = sessionLease;
  let released = false;
  return {
    holdsSession: () => held !== null,
    releaseSession() {
      held?.release();
      held = null;
    },
    restoreSession() {
      if (!held && !released) held = session();
      return held !== null;
    },
    release() {
      released = true;
      held?.release();
      held = null;
      for (const fence of fences) fence.release();
    },
  };
}

/**
 * WHAT: Returns whether a fenced lease regained its session within a bounded wait.
 * WHY: Prevents a pane write after a compact from running without the session lease.
 */
export async function regainSessionLease(lease, {
  timeoutMs = 30_000, pollMs = 250, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  if (typeof lease?.restoreSession !== "function") return true;
  for (let waited = 0; ; waited += pollMs) {
    if (lease.restoreSession()) return true;
    if (waited >= timeoutMs) return false;
    await sleep(pollMs);
  }
}
