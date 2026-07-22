import { expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  deliveryQueueDisplayRows,
  formatDeliveryQueueTable,
  listDeliveryQueueJobs,
  requestDeliveryQueueCancellation,
} from "./queue-format.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";

const NOW = Date.parse("2026-07-15T04:00:00Z");

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-queue-format-"));
  const queue = createDeliveryQueue({ rootDir, now: () => NOW });
  return { rootDir, queue };
}

feature("listDeliveryQueueJobs", () => {
  unit("operational truth excludes acknowledged jobs but keeps cancel requests", {
    given: ["one submitted, one acknowledged, one cancel-requested job", () => {
      const { rootDir, queue } = fixture();
      queue.enqueue({ agentName: "ai", pane: 0, text: "live work", createdAt: NOW - 1000 });
      const done = queue.enqueue({ agentName: "ai", pane: 0, text: "old work", createdAt: NOW - 2000 });
      queue.update(done, { status: "acknowledged", acknowledgedAt: NOW });
      const cancelling = queue.enqueue({ agentName: "ai", pane: 1, text: "stop this", createdAt: NOW - 500 });
      queue.requestCancellation(cancelling.id, { reason: "stale", requestedBy: "test" });
      return { jobs: listDeliveryQueueJobs(queue), rootDir };
    }],
    when: ["listing", (r) => r],
    then: ["submitted and cancel-requested remain, acknowledged drops", ({ jobs, rootDir }) => {
      expect(jobs.map((job) => job.text).sort()).toEqual(["live work", "stop this"]);
      rmSync(rootDir, { recursive: true, force: true });
    }],
  });
});

feature("deliveryQueueDisplayRows", () => {
  unit("rows carry target, age, state, and a control-noise-free preview", {
    given: ["a nine-hour stalled job with ANSI in the text", () => {
      const { rootDir, queue } = fixture();
      queue.enqueue({
        agentName: "ai", pane: 5, createdAt: NOW - 9 * 60 * 60 * 1000,
        text: "\u001b[31m[from ai:2]\u001b[0m\nRe-open the failed task",
      });
      return { rows: deliveryQueueDisplayRows(listDeliveryQueueJobs(queue), { now: NOW }), rootDir };
    }],
    when: ["mapping rows", (r) => r],
    then: ["age reads 9h 0m and preview is one clean line", ({ rows, rootDir }) => {
      expect(rows).toHaveLength(1);
      expect(rows[0].target).toBe("ai:5");
      expect(rows[0].age).toBe("9h 0m");
      expect(rows[0].state).toBe("pending");
      expect(rows[0].preview).not.toMatch(/\u001b|\n/);
      expect(rows[0].preview).toContain("Re-open the failed task");
      rmSync(rootDir, { recursive: true, force: true });
    }],
  });
});

feature("formatDeliveryQueueTable", () => {
  unit("an empty queue prints a single friendly line", {
    given: ["no rows", () => formatDeliveryQueueTable([])],
    when: ["formatting", (t) => t],
    then: ["the empty message", (table) => {
      expect(table).toBe("Delivery queue is empty.");
    }],
  });

  unit("a truncated view says how many more exist", {
    given: ["2 rows shown of 5 total", () => formatDeliveryQueueTable([
      { jobId: "a", target: "ai:0", age: "1m", state: "submitted", attempts: 0, reason: "", preview: "one" },
      { jobId: "b", target: "ai:1", age: "2m", state: "submitted", attempts: 1, reason: "", preview: "two" },
    ], { total: 5 })],
    when: ["formatting", (t) => t],
    then: ["header, two rows, and the more hint", (table) => {
      const lines = table.split("\n");
      expect(lines[0]).toContain("jobId");
      expect(lines).toHaveLength(4);
      expect(lines[3]).toContain("3 more");
    }],
  });
});

feature("requestDeliveryQueueCancellation", () => {
  unit("a first request is newlyRequested, a repeat is not", {
    given: ["one live job", () => {
      const { rootDir, queue } = fixture();
      const job = queue.enqueue({ agentName: "ai", pane: 0, text: "work", createdAt: NOW });
      return { queue, id: job.id, rootDir };
    }],
    when: ["requesting twice", ({ queue, id, rootDir }) => ({
      first: requestDeliveryQueueCancellation(queue, { id, reason: "stale", requestedBy: "test" }),
      second: requestDeliveryQueueCancellation(queue, { id, reason: "stale", requestedBy: "test" }),
      rootDir,
    })],
    then: ["only the first is new; the broker still adjudicates", ({ first, second, rootDir }) => {
      expect(first.newlyRequested).toBe(true);
      expect(second.newlyRequested).toBe(false);
      expect(first.job.cancelRequestStatus).toBe("requested");
      rmSync(rootDir, { recursive: true, force: true });
    }],
  });

  unit("an unknown job id throws", {
    given: ["an empty queue", () => fixture()],
    when: ["requesting cancellation", ({ queue, rootDir }) => ({
      error: (() => { try { requestDeliveryQueueCancellation(queue, { id: "nope", reason: "x" }); return null; } catch (err) { return err; } })(),
      rootDir,
    })],
    then: ["the error names the job", ({ error, rootDir }) => {
      expect(error.message).toBe("delivery job nope not found");
      rmSync(rootDir, { recursive: true, force: true });
    }],
  });
});
