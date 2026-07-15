import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";
import {
  deliveryQueueDisplayRows,
  dispatch,
  formatDeliveryQueueTable,
  listDeliveryQueueJobs,
  requestDeliveryQueueCancellation,
} from "../cli/commands.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";

const NOW = new Date("2026-07-15T04:00:00Z").getTime();
const fixture = () => {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-queue-cli-"));
  const queue = createDeliveryQueue({ rootDir, now: () => NOW });
  return { rootDir, queue };
};

feature("amux queue operational visibility", () => {
  component("one command identifies a nine-hour stalled delivery", {
    given: ["an old paste plus retained delivered history", () => {
      const ctx = fixture();
      const stalled = ctx.queue.enqueue({
        agentName: "ai",
        pane: 5,
        text: "\u001b[31m[from ai:2]\u001b[0m\nRe-open the exact failed task and preserve all evidence",
        createdAt: NOW - 9 * 60 * 60 * 1000,
      });
      ctx.queue.update(stalled, {
        status: "pasting",
        attempts: 521,
        lastReason: "foreign composer preserved;\nwaiting for an exact receipt",
      });
      const delivered = ctx.queue.enqueue({
        agentName: "lsrc", pane: 8, text: "already delivered", createdAt: NOW - 1_000,
      });
      ctx.queue.update(delivered, { status: "acknowledged", acknowledgedAt: NOW });
      return { ...ctx, stalled, delivered };
    }],
    when: ["the default and historical views are formatted", ({ queue }) => {
      const active = deliveryQueueDisplayRows(listDeliveryQueueJobs(queue), { now: NOW });
      const all = deliveryQueueDisplayRows(listDeliveryQueueJobs(queue, { includeTerminal: true }), { now: NOW });
      return { active, all, table: formatDeliveryQueueTable(active) };
    }],
    then: ["the full id, target, age, state, attempts, reason and preview are visible without grep", ({ active, all, table }, ctx) => {
      expect(active).toHaveLength(1);
      expect(table).toContain(ctx.stalled.id);
      expect(table).toContain("ai:5");
      expect(table).toContain("9h 0m");
      expect(table).toContain("pasting");
      expect(table).toContain("521");
      expect(table).toContain("foreign composer preserved");
      expect(table).toContain("Re-open the exact failed task");
      expect(table).not.toContain("\u001b");
      expect(all.find((row) => row.jobId === ctx.delivered.id)?.state).toBe("delivered");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("sender cancellation is durable, idempotent, and never presented as complete", {
    given: ["one queued job", () => {
      const ctx = fixture();
      const job = ctx.queue.enqueue({ agentName: "lsrc", pane: 8, text: "obsolete follow-up" });
      return { ...ctx, job };
    }],
    when: ["the sender loses the first response and retries", ({ queue, job }) => {
      const first = requestDeliveryQueueCancellation(queue, {
        id: job.id, reason: "already handled elsewhere", requestedBy: "lsrc:2",
      });
      const retry = requestDeliveryQueueCancellation(queue, {
        id: job.id, reason: "a retry must not replace the audit", requestedBy: "lsrc:2",
      });
      const row = deliveryQueueDisplayRows(listDeliveryQueueJobs(queue), { now: NOW })[0];
      return { first, retry, persisted: queue.findById(job.id), row };
    }],
    then: ["one pending broker request keeps the original reason and truthful delivery state", ({ first, retry, persisted, row }, ctx) => {
      expect(first.newlyRequested).toBe(true);
      expect(retry.newlyRequested).toBe(false);
      expect(persisted).toMatchObject({
        status: "pending",
        cancelRequestStatus: "requested",
        cancelRequestedBy: "lsrc:2",
        cancelRequestedReason: "already handled elsewhere",
      });
      expect(row.state).toBe("pending+cancel_requested");
      expect(row.reason).toContain("already handled elsewhere");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("dispatch exposes list and cancel through the public CLI", {
    given: ["an injected hermetic spool and console", () => {
      const ctx = fixture();
      const job = ctx.queue.enqueue({ agentName: "skydive", pane: 7, text: "queued work" });
      const output = [];
      const spy = vi.spyOn(console, "log").mockImplementation((...parts) => output.push(parts.join(" ")));
      return { ...ctx, job, output, spy };
    }],
    when: ["list then cancel are dispatched", async ({ queue, job, output }) => {
      const commandContext = { deliveryQueue: queue, deliveryQueueRequester: "claw:3", now: () => NOW };
      await dispatch(["queue"], commandContext);
      await dispatch(["queue", "cancel", job.id, "--reason", "superseded"], commandContext);
      return { output, persisted: queue.findById(job.id) };
    }],
    then: ["the command lists the job and calls the durable request engine", ({ output, persisted }, ctx) => {
      ctx.spy.mockRestore();
      expect(output.join("\n")).toContain(ctx.job.id);
      expect(output.join("\n")).toContain("Cancellation requested");
      expect(output.join("\n")).toContain("not a cancellation receipt");
      expect(persisted).toMatchObject({
        status: "pending",
        cancelRequestStatus: "requested",
        cancelRequestedBy: "claw:3",
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });
});
