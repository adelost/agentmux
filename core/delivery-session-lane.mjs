// One delivery lane per tmux session. Panes share one tmux window, and a tiled delivery that cannot render its
// composer may temporarily zoom the target as a fallback; therefore the in-process critical section is session-wide
// even though FIFO ordering is per pane.

import { deliveryHead } from "./delivery-wake.mjs";

/** WHAT: Builds the session-wide delivery lanes. WHY: Keeps one pane's zoom or backlog from racing or holding its session. */
export function createSessionLanes({ queue, now = () => Date.now() }) {
  const lanes = new Map();
  const drains = new Map();
  const laneKey = (agentName) => String(agentName);

  function runExclusive(agentName, _pane, work) {
    const key = laneKey(agentName);
    const previous = lanes.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    let tracked;
    tracked = next.finally(() => {
      if (lanes.get(key) === tracked) lanes.delete(key);
    });
    lanes.set(key, tracked);
    return tracked;
  }

  /** WHAT: Shares one pending drain per pane. WHY: Repeated polls must not enqueue thousands of duplicate passes behind a busy sibling. */
  function runDrain(agentName, pane, work) {
    const key = `${agentName}:${pane}`;
    if (drains.has(key)) return drains.get(key);
    let tracked;
    tracked = runExclusive(agentName, pane, work).finally(() => {
      if (drains.get(key) === tracked) drains.delete(key);
    });
    drains.set(key, tracked);
    return tracked;
  }

  // claw, 2026-10-20 16:1xZ: after a quota recovery the lane delivered claw:0's seven paused jobs and claw:1's ten
  // before claw:2's continuation, 11 minutes after its restart. A pane yields the lane once another pane waits.
  /** WHAT: Checks whether another pane of the session has a head to deliver now. WHY: Keeps one pane's backlog from holding the session. */
  function peerWaiting(agentName, pane) {
    return queue.targets().some((target) => {
      if (laneKey(target.agentName) !== laneKey(agentName) || String(target.pane) === String(pane)) return false;
      const head = deliveryHead(queue.list(target.agentName, target.pane));
      return Boolean(head) && Number(head.nextAttemptAt || 0) <= now();
    });
  }

  return { runExclusive, runDrain, peerWaiting, settle: () => Promise.allSettled([...lanes.values()]) };
}
