import { createDeliveryQueue, DELIVERED_UNVERIFIED_STATE } from "./delivery-queue.mjs";
import { DREAM_POLL_MS } from "./dream-result.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// The prompt has left the queue once AMUX typed it into the pane. An unverified
// receipt still counts: the curator may be working, and its file is the receipt.
const SUBMITTED = new Set(["submitting", "submitted", "acknowledged", DELIVERED_UNVERIFIED_STATE]);

/** WHAT: Checks the queued prompt until it is submitted, or removes it at the deadline. WHY: Prevents a job that only waits in the queue from counting as a prompt the curator received. */
export async function waitForDreamSubmission({
  sent, queue = null, deadlineMs, pollMs = DREAM_POLL_MS, sleep = wait, nowMs = Date.now,
}) {
  if (!sent.pending || SUBMITTED.has(sent.queueState)) return { submitted: true };
  if (!sent.jobId) throw new Error("dream-owner-prompt-pending: the queue gave no job id to follow");
  const jobs = queue || createDeliveryQueue();
  for (;;) {
    const job = jobs.findById(sent.jobId);
    if (!job) throw new Error(`dream-owner-prompt-job-missing:${sent.jobId}`);
    if (SUBMITTED.has(job.status)) return { submitted: true, status: job.status };
    if (job.status === "cancelled") throw new Error(`dream-owner-prompt-cancelled:${job.lastReason || "unknown"}`);
    if (nowMs() >= deadlineMs) {
      jobs.requestCancellation(job.id, { reason: "Dream deadline 12:00 local passed before the prompt left the queue", requestedBy: "amux dream" });
      throw new Error(`dream-owner-prompt-pending: the prompt never left the queue (${job.status}) before 12:00 local; the job was removed`);
    }
    await sleep(pollMs);
  }
}
