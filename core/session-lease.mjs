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
export function acquireSessionWriteLease({ session, paneFence, fencedPanes, onBusy = () => {} }, pane = null) {
  const sessionLease = session();
  if (!sessionLease) { onBusy({ kind: "session" }); return null; }
  // Without a pane the caller acts on the whole session (sleep, rotation,
  // model change) and must wait for every fenced pane, as it did before.
  const fences = [];
  let transferred = false;
  try {
    for (const target of pane == null ? fencedPanes() : [pane]) {
      const fence = paneFence(target);
      if (!fence) { onBusy({ kind: "pane", pane: target }); return null; }
      fences.push(fence);
    }
    transferred = true;
  } finally {
    // A pane lock can fail while writing its owner metadata (e.g. ENOSPC).
    // Its caller must also close the session fd it already acquired.
    if (!transferred) releaseLeases([sessionLease, ...fences]);
  }
  let held = sessionLease;
  let released = false;
  return {
    holdsSession: () => held !== null,
    releaseSession() {
      const previous = held;
      held = null;
      previous?.release();
    },
    restoreSession() {
      if (!held && !released) held = session();
      return held !== null;
    },
    release() {
      if (released) return;
      released = true;
      const previous = held;
      held = null;
      releaseLeases([previous, ...fences]);
    },
  };
}

function releaseLeases(leases) {
  const errors = [];
  for (const lease of leases) {
    try { lease?.release(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length) throw new AggregateError(errors, "session lease cleanup failed");
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

/** WHAT: Returns a candidate pane's session lease within a monotonic bound. WHY: Keeps sibling fences and transient contention from blocking a safe account move indefinitely. */
export async function waitForSessionLease(queue, agentName, pane, {
  timeoutMs = 30_000, pollMs = 250, now = () => performance.now(),
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  let busy = "session";
  for (;;) {
    const lease = queue.acquireSessionLease?.(agentName, pane, {
      onBusy: lock => { busy = lock.kind === "pane" ? `pane${lock.pane}` : "session"; },
    });
    if (lease) return { lease, reason: null };
    const left = deadline - now();
    if (left <= 0) return { lease: null, reason: `delivery-lease-busy:${agentName}:${busy}` };
    await sleep(Math.min(pollMs, left));
  }
}
