import { withDeliveryWriter } from "./delivery-writer.mjs";
import { deliveryHead } from "./delivery-wake.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";

/** WHAT: Dispatches eligible heads with one leased preparation scope each. WHY: Prevents a completed physical operation from disabling the next head's unsent bound. */
export async function drainDeliveryJobs({ queue, agentName, pane, log, preparationTimeoutMs,
  stopped, preflight, yieldMaintenance, answerBacklog, processJob, peerWaiting, now }) {
  let again = true;
  while (again && !stopped()) {
    again = false;
    await withDeliveryWriter({ queue, agentName, pane, log, preparationTimeoutMs, now }, async context => {
      context.job = deliveryHead(queue.list(agentName, pane));
      await preflight();
      const head = deliveryHead(queue.list(agentName, pane));
      if (!head) return;
      context.job = head;
      const yielded = await yieldMaintenance(head);
      if (yielded && TERMINAL_DELIVERY_STATES.has(yielded.status)) { again = true; return; }
      await answerBacklog(agentName, pane, head);
      if (Number(head.nextAttemptAt || 0) > now()) return;
      const outcome = await processJob(head, context.lease);
      again = TERMINAL_DELIVERY_STATES.has(outcome.status) && !peerWaiting(agentName, pane);
    });
  }
}
