import { feature, component, expect } from "bdd-vitest";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import { join } from "path";
import { tmpdir } from "os";
import { createDeliveryQueue, deliveryQueueStats, waitForDeliveryJob } from "./delivery-queue.mjs";

const tempRoot = () => join(tmpdir(), `amux-delivery-queue-${process.pid}-${Math.random().toString(36).slice(2)}`);
const execFileAsync = promisify(execFile);

feature("durable delivery queue", () => {
  component("provisional paste health survives a queue restart", {
    given: ["one durable paste that has not yet proved its exact composer text", () => {
      const rootDir = tempRoot();
      const createdAt = 1_000;
      const queue = createDeliveryQueue({ rootDir, now: () => createdAt });
      const job = queue.enqueue({ agentName: "skydive", pane: 7, text: "owned provisional paste" });
      queue.update(job, { status: "pasting", draftOwned: true, nextAttemptAt: 2_000 });
      return { rootDir, createdAt };
    }],
    when: ["a replacement process reads canonical queue health", ({ rootDir }) =>
      deliveryQueueStats(createDeliveryQueue({ rootDir }))],
    then: ["the provisional owner remains visible instead of looking like an empty queue", (stats, ctx) => {
      expect(stats).toMatchObject({
        pending: 0, pasting: 1, drafted: 0, submitted: 0, blocked: 0,
        total: 1, oldestCreatedAt: ctx.createdAt,
      });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("Discord Gateway and REST replay create one stable job", {
    given: ["an empty private spool", () => {
      const rootDir = tempRoot();
      mkdirSync(rootDir, { recursive: true });
      return { rootDir, queue: createDeliveryQueue({ rootDir, now: () => 1000 }) };
    }],
    when: ["the same Discord identity is enqueued twice around a state update", ({ queue }) => {
      const first = queue.enqueue({
        agentName: "ai", pane: 5, text: "long image prompt", idempotencyKey: "discord:ch:42",
      });
      queue.update(first, { status: "drafted", draftOwned: true, attempts: 1 });
      const replay = queue.enqueue({
        agentName: "ai", pane: 5, text: "long image prompt", idempotencyKey: "discord:ch:42",
      });
      return { first, replay };
    }],
    then: ["replay preserves the drafted transaction instead of resetting it", ({ first, replay }, ctx) => {
      expect(replay.id).toBe(first.id);
      expect(replay).toMatchObject({ status: "drafted", draftOwned: true, attempts: 1 });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("FIFO order survives a new queue instance", {
    given: ["three jobs persisted out of call-order but with explicit source order", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      queue.enqueue({ agentName: "lsrc", pane: 3, text: "third", orderKey: "003" });
      queue.enqueue({ agentName: "lsrc", pane: 3, text: "first", orderKey: "001" });
      queue.enqueue({ agentName: "lsrc", pane: 3, text: "second", orderKey: "002" });
      return { rootDir };
    }],
    when: ["the bridge restarts and opens the same spool", ({ rootDir }) => {
      const reopened = createDeliveryQueue({ rootDir });
      return reopened.list("lsrc", 3).map((job) => job.text);
    }],
    then: ["the exact per-pane order remains", (texts, ctx) => {
      expect(texts).toEqual(["first", "second", "third"]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("message identity dedup survives a queue restart", {
    given: ["one submitted Discord job on disk", () => {
      const rootDir = tempRoot();
      const firstQueue = createDeliveryQueue({ rootDir });
      const first = firstQueue.enqueue({
        agentName: "ai",
        pane: 5,
        text: "same Discord message",
        idempotencyKey: "discord:channel:message-42",
      });
      firstQueue.update(first, { status: "submitted", submittedAt: 1_000 });
      return { rootDir, first };
    }],
    when: ["a replacement bridge enqueues the same message identity", ({ rootDir }) => {
      const reopened = createDeliveryQueue({ rootDir });
      const replay = reopened.enqueue({
        agentName: "ai",
        pane: 5,
        text: "same Discord message",
        idempotencyKey: "discord:channel:message-42",
      });
      return { replay, jobs: reopened.list("ai", 5) };
    }],
    then: ["the durable submitted fence is reused instead of creating a second job", ({ replay, jobs }, ctx) => {
      expect(replay).toMatchObject({ id: ctx.first.id, status: "submitted", submittedAt: 1_000 });
      expect(jobs).toHaveLength(1);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("delivered-unverified is durable and terminal across restart", {
    given: ["one submission whose receipt audit timed out", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir, now: () => 4_000 });
      const job = queue.enqueue({
        agentName: "skydive", pane: 3, text: "do not resend", idempotencyKey: "discord:late:42",
      });
      queue.update(job, {
        status: "delivered_unverified",
        terminalAt: 4_000,
        unverifiedNoticeSentAt: 4_000,
        nextAttemptAt: null,
      });
      return { rootDir, job };
    }],
    when: ["a replacement bridge opens the spool and polls the same job", async ({ rootDir, job }) => {
      const reopened = createDeliveryQueue({ rootDir });
      return {
        settled: await waitForDeliveryJob(reopened, job.id, { timeoutMs: 0 }),
        next: reopened.next("skydive", 3),
        targets: reopened.targets(),
      };
    }],
    then: ["the audit record remains readable but cannot re-enter delivery", ({ settled, next, targets }, ctx) => {
      expect(settled).toMatchObject({
        id: ctx.job.id,
        status: "delivered_unverified",
        terminalAt: 4_000,
      });
      expect(next).toBeNull();
      expect(targets).toEqual([]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("delivered-unverified audit retention uses terminalAt", {
    given: ["a notified terminal audit record before its retention cutoff", () => {
      const rootDir = tempRoot();
      let clock = 10_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({ agentName: "skydive", pane: 3, text: "retain audit" });
      queue.update(job, {
        status: "delivered_unverified",
        terminalAt: 5_000,
        unverifiedNoticeSentAt: 5_000,
        nextAttemptAt: null,
      });
      return { rootDir, queue, job, advance: () => { clock = 12_000; } };
    }],
    when: ["pruning once before and once after the cutoff", ({ queue, job, advance }) => {
      const before = queue.prune({ acknowledgedOlderThanMs: 6_000 });
      const retained = queue.read("skydive", 3, job.id);
      advance();
      const after = queue.prune({ acknowledgedOlderThanMs: 6_000 });
      const removed = queue.read("skydive", 3, job.id);
      return { before, retained, after, removed };
    }],
    then: ["the audit is retained before cutoff and removed only after it", ({ before, retained, after, removed }, ctx) => {
      expect(before).toBe(0);
      expect(retained).toMatchObject({ status: "delivered_unverified", terminalAt: 5_000 });
      expect(after).toBe(1);
      expect(removed).toBeNull();
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("CLI polling distinguishes acknowledged from pending", {
    given: ["one queued job", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "claw", pane: 3, text: "test" });
      return { rootDir, queue, job };
    }],
    when: ["polling without a broker", ({ queue, job }) =>
      waitForDeliveryJob(queue, job.id, { timeoutMs: 0 })],
    then: ["the caller gets an honest durable pending state", (job, ctx) => {
      expect(job.status).toBe("pending");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("independent producer processes cannot merge pane writes", {
    given: ["one shared spool and two standalone Node producers", () => {
      const rootDir = tempRoot();
      mkdirSync(rootDir, { recursive: true });
      return { rootDir };
    }],
    when: ["both processes enqueue concurrently for the same pane", async ({ rootDir }) => {
      const moduleUrl = new URL("./delivery-queue.mjs", import.meta.url).href;
      const producer = [
        `import { createDeliveryQueue } from ${JSON.stringify(moduleUrl)};`,
        "const [root, text, order] = process.argv.slice(1);",
        "createDeliveryQueue({ rootDir: root }).enqueue({ agentName: 'api', pane: 4, text, orderKey: order });",
      ].join("\n");
      await Promise.all([
        execFileAsync(process.execPath, ["--input-type=module", "-e", producer, rootDir, "first process", "001"]),
        execFileAsync(process.execPath, ["--input-type=module", "-e", producer, rootDir, "second process", "002"]),
      ]);
      return createDeliveryQueue({ rootDir }).list("api", 4);
    }],
    then: ["the broker sees two intact FIFO jobs", (jobs, ctx) => {
      expect(jobs.map((job) => job.text)).toEqual(["first process", "second process"]);
      expect(jobs.map((job) => job.status)).toEqual(["pending", "pending"]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("attachment bytes survive cleanup and bridge restart", {
    given: ["an image marker whose temporary source exists during enqueue", () => {
      const rootDir = tempRoot();
      const imagePath = join(tempRoot(), "discord-image.png");
      mkdirSync(join(imagePath, ".."), { recursive: true });
      writeFileSync(imagePath, Buffer.from("fake-png-bytes"));
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({
        agentName: "ai", pane: 5, text: `inspect\n[image attached: ${imagePath}]`,
      });
      unlinkSync(imagePath);
      return { rootDir, imagePath, queue, job };
    }],
    when: ["the replacement broker restores durable assets", ({ queue, job }) => queue.restoreAssets(job)],
    then: ["the exact original path and bytes are available to the agent", (count, ctx) => {
      expect(count).toBe(1);
      expect(readFileSync(ctx.imagePath, "utf-8")).toBe("fake-png-bytes");
      rmSync(ctx.rootDir, { recursive: true, force: true });
      rmSync(join(ctx.imagePath, ".."), { recursive: true, force: true });
    }],
  });

  component("only one bridge process may consume a pane", {
    given: ["two queue instances over the same spool", () => {
      const rootDir = tempRoot();
      return {
        rootDir,
        first: createDeliveryQueue({ rootDir }),
        second: createDeliveryQueue({ rootDir }),
      };
    }],
    when: ["both attempt to lease the same pane", ({ first, second }) => {
      const owner = first.acquireTargetLease("api", 4);
      const rejected = second.acquireTargetLease("api", 4);
      owner.release();
      const successor = second.acquireTargetLease("api", 4);
      return { owner, rejected, successor };
    }],
    then: ["the second consumer waits until the first releases", ({ owner, rejected, successor }, ctx) => {
      expect(owner).toBeTruthy();
      expect(rejected).toBeNull();
      expect(successor).toBeTruthy();
      successor.release();
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("one tmux session lease covers all of its panes", {
    given: ["two queue instances over the same spool", () => {
      const rootDir = tempRoot();
      return { rootDir, first: createDeliveryQueue({ rootDir }), second: createDeliveryQueue({ rootDir }) };
    }],
    when: ["one bridge leases api while another targets a different api pane", ({ first, second }) => {
      const owner = first.acquireSessionLease("api");
      const rejected = second.acquireSessionLease("api");
      owner.release();
      return { rejected };
    }],
    then: ["window-global TUI operations cannot overlap", ({ rejected }, ctx) => {
      expect(rejected).toBeNull();
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });
});
