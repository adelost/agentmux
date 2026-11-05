import { sendToPane } from "./tmux.mjs";
import { panePathFor } from "../core/jsonl-reader.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { beginContextCompact, contextMaintenanceAttempt } from "../core/context-maintenance.mjs";
import { updateCompactReceipt } from "../core/compact-receipts.mjs";
import { waitForSessionLease } from "../core/session-lease.mjs";

/** WHAT: Routes a manual compact under the shared receipt fence. WHY: Prevents an automated trigger from duplicating the same queued model call. */
export async function sendRecordedCompact(ctx, agent, pane, engine, command) {
  if (!ctx.state || !ctx.deliveryQueue) return { delivered: false, blocked: true, reason: "compact-store-unavailable" };
  const acquired = await waitForSessionLease(ctx.deliveryQueue, agent.name, pane);
  if (!acquired.lease) return { delivered: false, blocked: true, reason: acquired.reason };
  let attempt, queued;
  try {
    const identity = latestPaneSessionIdentity(engine, panePathFor(agent, pane));
    if (!identity?.sessionId || !identity.path) return { delivered: false, blocked: true, reason: "exact-session-unknown" };
    const previous = contextMaintenanceAttempt(ctx.state, agent.name, pane, identity);
    if (previous && previous.status !== "VERIFIED") return { delivered: false, blocked: true, reason: `compact-${previous.status.toLowerCase()}` };
    attempt = beginContextCompact(ctx.state, agent.name, pane, identity, { command, source: "manual" });
    queued = sendToPane(ctx, agent.name, pane, command, { source: "amux:compact" });
  } finally { acquired.lease.release(); }
  try {
    const result = await queued;
    if (!result?.delivered && !result?.pending) updateCompactReceipt(ctx.state, `${agent.name}:${pane}`, current =>
      current.attemptId === attempt.attemptId ? { ...current, status: "NOT_SENT", reason: result?.reason || "delivery-refused", finishedAt: Date.now() } : current);
    return result;
  } catch (error) {
    updateCompactReceipt(ctx.state, `${agent.name}:${pane}`, current => current.attemptId === attempt.attemptId
      ? { ...current, status: "UNKNOWN", reason: "manual-compact-delivery-unknown", finishedAt: Date.now() } : current);
    throw error;
  }
}
