import { codexUserPrompt } from "./codex-user-events.mjs";
import { parseJsonlText, readTailWindow } from "./jsonl-reader.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { findBlockingPrompt } from "./dismiss.mjs";

/** WHAT: Identifies fully observed maintenance-only compact tasks. WHY: Their lifecycle must not cancel recovery of the unfinished product task. */
function completedCompactionTurns(events) {
  const completed = new Set();
  let task = null;
  for (const event of events) {
    const payload = event.payload;
    if (event.type === "event_msg" && payload?.type === "task_started") {
      task = payload.turn_id ? { id: payload.turn_id, compacted: false, work: false } : null;
    }
    if (!task) continue;
    if (event.type === "compacted") task.compacted = true;
    if (codexUserPrompt(event) !== null || (event.type === "event_msg" && payload?.type === "agent_message")
        || (event.type === "response_item" && (payload?.role === "assistant"
          || ["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(payload?.type)))) task.work = true;
    if (event.type !== "event_msg") continue;
    if (payload?.type === "task_complete" && payload.turn_id === task.id) {
      if (task.compacted && !task.work && payload.last_agent_message === null && !payload.error) completed.add(task.id);
      task = null;
    }
    if (payload?.type === "turn_aborted") task = null;
  }
  return completed;
}

/** WHAT: Checks automatic continuations at the broker's physical boundary. WHY: Prevents input arriving after scheduling from receiving a stale continuation. */
export async function fenceCodexCapacityJobs({ agentName, pane, queue, agent, now, terminalizeNotSent, log }) {
  for (const job of queue.list(agentName, pane)) {
    if (!["codex-capacity-recovery", "codex-limit-recovery"].includes(job.source)
        || job.status !== "pending" || job.attempts > 0 || job.draftOwned) continue;
    try {
      const after = Date.parse(job.metadata?.capacityRefusedAt);
      const events = parseJsonlText(readTailWindow(job.metadata.capacitySessionFile, 256 * 1024).text);
      const compactions = completedCompactionTurns(events);
      const superseded = events.some(event => Date.parse(event.timestamp) > after
        && (codexUserPrompt(event) !== null || (event.type === "event_msg"
          && ["task_started", "task_complete", "turn_aborted"].includes(event.payload?.type)
          && (event.payload.type === "turn_aborted" || !compactions.has(event.payload.turn_id)))))
        || queue.list(agentName, pane).some(other => other.id !== job.id && other.createdAt >= job.createdAt
          && other.source !== job.source && !TERMINAL_DELIVERY_STATES.has(other.status));
      if (superseded) {
        queue.requestCancellation(job.id, { requestedBy: "delivery-broker", reason: "capacity continuation superseded by new input or activity" });
        await terminalizeNotSent(queue.read(agentName, pane, job.id));
        continue;
      }
      const transport = await agent.promptTransportState(agentName, pane, job.text);
      if (transport.dialect === "codex" && transport.state === "empty-idle" && !transport.busy
          && !findBlockingPrompt(await agent.captureScreen(agentName, pane))) continue;
      queue.update(job, { nextAttemptAt: now() + 15_000, lastReason: "capacity continuation waits for an idle Codex composer" });
    } catch (error) {
      log(`capacity continuation held: ${error.message}`);
      queue.update(job, { nextAttemptAt: now() + 15_000, lastReason: "capacity continuation evidence unavailable" });
    }
  }
}
