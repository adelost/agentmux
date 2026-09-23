import { rewriteModelSlash } from "./claude-model.mjs";

const QWEN_CURSOR_KIND = "qwen-dual-output-v1";

/** WHAT: Builds a pre-write journal cursor. WHY: Prevents a Qwen wake from binding a new prompt to an obsolete process generation. */
export async function captureDeliveryCursor({ agent, job, queue, log, afterWake = false }) {
  if (!agent || !job || !queue || job.metadata?.deliveryTransport === "native"
      || (job.kind !== "prompt" && job.kind !== "slash")) return job;
  if (afterWake) {
    // A submitted or provisionally pasted job may already have reached its
    // original generation. Its cursor is a fence, never a refresh candidate.
    if (job.submitFenceAt || job.draftOwned || job.metadata?.submittedRecoveryAt
        || (job.echoCursor && job.echoCursor.kind !== QWEN_CURSOR_KIND)) return job;
  } else if (job.echoCursor) return job;

  const capture = job.kind === "slash"
    ? agent.captureSlashReceiptCursor : agent.capturePromptEchoCursor;
  if (typeof capture !== "function") return job;
  const text = job.kind === "slash" ? rewriteModelSlash(job.verifyText) : job.verifyText;
  let cursor = null;
  try {
    cursor = await capture.call(agent, job.agentName, job.pane, text);
  } catch (error) {
    log(`delivery broker cursor failed for ${job.agentName}:${job.pane}: ${error.message}`);
  }
  if (!cursor || (afterWake && job.echoCursor && cursor.kind !== QWEN_CURSOR_KIND)) return job;
  if (afterWake && job.echoCursor
      && job.echoCursor.generation === cursor.generation
      && job.echoCursor.sessionId === cursor.sessionId) return job;
  return queue.update(job, { echoCursor: cursor });
}
