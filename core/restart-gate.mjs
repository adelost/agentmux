import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { liveCompactAttempts } from "./context-maintenance.mjs";

/** WHAT: Checks the delivery queue and live compact attempts before a bridge restart. WHY: Prevents a restart from cutting a delivery or a compact in flight. */
export function restartGate({ queue, state, bridgePid, now = Date.now(), alive } = {}) {
  if (!Number.isInteger(bridgePid)) throw new Error("restartGate needs the bridge pid");
  const jobs = queue.targets().flatMap(({ agentName, pane }) => queue.list(agentName, pane).map(job => ({ agentName, pane, job })))
    .filter(({ job }) => !TERMINAL_DELIVERY_STATES.has(job.status))
    .map(({ agentName, pane, job }) => ({ id: job.id, target: `${agentName}:${pane}`, status: job.status }));
  const maintenance = liveCompactAttempts(state, { now, alive, self: bridgePid });
  return { allowed: !jobs.length && !maintenance.length, jobs, maintenance };
}
