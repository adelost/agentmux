import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { waitForDreamSubmission } from "./dream-submission.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

// The real delivery queue, so the job fields and the cancellation call are the ones production uses.
function pendingJob() {
  const rootDir = mkdtempSync(join(tmpdir(), "dream-submission-")); roots.push(rootDir);
  const queue = createDeliveryQueue({ rootDir });
  const job = queue.enqueue({ agentName: "sandman", pane: 0, text: "prompt", source: "dream", idempotencyKey: "dream:2026-10-27:run" });
  return { rootDir, queue, job, sent: { delivered: true, pending: true, queueState: job.status, jobId: job.id } };
}

describe("a Dream prompt that only waits in the real delivery queue", () => {
  it("asks the queue to remove it at the deadline and says it never left the queue", async () => {
    const { rootDir, queue, job, sent } = pendingJob();
    await expect(waitForDreamSubmission({ sent, queue, deadlineMs: 0, nowMs: () => 1 }))
      .rejects.toThrow("dream-owner-prompt-pending");
    expect(queue.findById(job.id)).toMatchObject({ cancelRequestStatus: "requested", cancelRequestedBy: "amux dream" });
    expect(readdirSync(join(rootDir, "sandman--p0")).some(name => name.endsWith(".cancel-request"))).toBe(true);
  });

  it("returns once the job is submitted and cancels nothing", async () => {
    const { queue, job, sent } = pendingJob();
    let polls = 0;
    const result = await waitForDreamSubmission({ sent, queue, deadlineMs: 10_000, nowMs: () => polls * 1_000,
      sleep: async () => { polls += 1; if (polls === 3) queue.update(queue.findById(job.id), { status: "submitted" }); } });
    expect(result).toMatchObject({ submitted: true, status: "submitted" });
    expect(queue.findById(job.id).cancelRequestStatus).toBeNull();
  });
});
