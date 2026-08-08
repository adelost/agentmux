import { feature, component, expect } from "bdd-vitest";
import { rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";

const tempRoot = () => join(tmpdir(), `amux-late-echo-${process.pid}-${Math.random().toString(36).slice(2)}`);

const ONE_HOUR = 60 * 60_000;
const WATCH_REASON = "slash lane released after 60 seconds; the exact command receipt is still watched for until the 60-minute mark";

function slashAgent(receipt) {
  const echoed = new Set();
  const sends = [];
  return {
    sends,
    capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
    captureSlashReceiptCursor: async () => ({ kind: "test", positions: {} }),
    waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
    waitForSlashReceipt: async () => receipt(),
    dismissBlockingPrompt: async () => null,
    sendOnly: async (_name, text, _pane, options = {}) => {
      sends.push(text);
      await options.onPasteStarted?.();
      await options.onDrafted?.();
      await options.onSubmitting?.();
      await options.onSubmitted?.();
      echoed.add(text);
      return { submitted: true, queued: false };
    },
    sendEnter: async () => {},
    capturePane: async () => "› ",
  };
}

function submittedSlashJob(queue) {
  const job = queue.enqueue({
    agentName: "lsrc", pane: 2, text: "/model fable", source: "discord", createdAt: 1_000,
  });
  return queue.update(job, {
    kind: "slash",
    status: "submitted",
    submittedAt: 1_000,
    nextAttemptAt: 0,
    echoCursor: { kind: "claude-slash-events-v1", positions: {} },
  });
}

feature("late-echo watch after the slash lane deadline", () => {
  component("the 60-second verdict releases the lane but keeps the receipt channel open", {
    given: ["a submitted slash whose receipt has not arrived after a minute", () => {
      const rootDir = tempRoot();
      let clock = 70_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = submittedSlashJob(queue);
      const notices = [];
      const agent = slashAgent(() => false);
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, agent, broker, tick: (ms) => { clock = ms; } };
    }],
    when: ["the deadline fires and a follow-up prompt arrives", async (ctx) => {
      await ctx.broker.kickTarget("lsrc", 2);
      ctx.queue.enqueue({ agentName: "lsrc", pane: 2, text: "follow-up prompt", source: "discord" });
      ctx.tick(80_000);
      await ctx.broker.kickTarget("lsrc", 2);
    }],
    then: ["the verdict is soft, the watch is armed for the full hour, and the lane flows", (_, ctx) => {
      expect(ctx.queue.read("lsrc", 2, ctx.job.id)).toMatchObject({
        status: "delivered_unverified",
        lateEchoWatchUntil: 1_000 + ONE_HOUR,
        unverifiedNoticeNextAttemptAt: 1_000 + ONE_HOUR,
        unverifiedNoticeSentAt: null,
        lastReason: WATCH_REASON,
      });
      expect(ctx.queue.read("lsrc", 2, ctx.job.id).noticeSentAt).toBeTruthy();
      expect(ctx.notices).toEqual(["stalled"]);
      expect(ctx.agent.sends).toContain("follow-up prompt");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a receipt that arrives after the deadline flips the verdict and confirms", {
    given: ["a lane-released slash whose receipt lands minutes later", () => {
      const rootDir = tempRoot();
      let clock = 70_000;
      let receipt = false;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = submittedSlashJob(queue);
      const notices = [];
      const agent = slashAgent(() => receipt);
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return {
        rootDir, queue, job, notices, broker,
        tick: (ms) => { clock = ms; },
        landReceipt: () => { receipt = true; },
      };
    }],
    when: ["the receipt lands and later polls pass the old warning horizon", async (ctx) => {
      await ctx.broker.kickTarget("lsrc", 2);
      ctx.landReceipt();
      ctx.tick(300_000);
      await ctx.broker.kickTarget("lsrc", 2);
      ctx.tick(1_000 + ONE_HOUR + 60_000);
      await ctx.broker.kickTarget("lsrc", 2);
    }],
    then: ["the job is acknowledged, the human sees the confirmation, and no warning ever fires", (_, ctx) => {
      expect(ctx.queue.read("lsrc", 2, ctx.job.id)).toMatchObject({
        status: "acknowledged",
        acknowledgedAt: 300_000,
      });
      expect(ctx.notices).toEqual(["stalled", "recovered"]);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a receipt that never arrives warns once at the hour, honestly", {
    given: ["a lane-released slash on a pane that never writes the receipt", () => {
      const rootDir = tempRoot();
      let clock = 70_000;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = submittedSlashJob(queue);
      const notices = [];
      const agent = slashAgent(() => false);
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, broker, tick: (ms) => { clock = ms; } };
    }],
    when: ["the watch window lapses and the broker keeps polling", async (ctx) => {
      await ctx.broker.kickTarget("lsrc", 2);
      ctx.tick(1_000 + ONE_HOUR + 1);
      await ctx.broker.kickTarget("lsrc", 2);
      ctx.tick(1_000 + ONE_HOUR + 30_000);
      await ctx.broker.kickTarget("lsrc", 2);
    }],
    then: ["exactly one warning fires, and its recorded reason matches what happened", (_, ctx) => {
      expect(ctx.notices).toEqual(["stalled", "unverified"]);
      expect(ctx.queue.read("lsrc", 2, ctx.job.id)).toMatchObject({
        status: "delivered_unverified",
        lateEchoWatchUntil: null,
        lastReason: "no exact command receipt within the 60-minute watch window; delivery remains unverified",
      });
      expect(ctx.queue.read("lsrc", 2, ctx.job.id).unverifiedNoticeSentAt).toBeTruthy();
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a prompt at its hour deadline keeps today's immediate warning", {
    given: ["a submitted prompt with no receipt a full hour later", () => {
      const rootDir = tempRoot();
      const clock = 1_000 + ONE_HOUR + 1;
      const queue = createDeliveryQueue({ rootDir, now: () => clock });
      const job = queue.enqueue({
        agentName: "lsrc", pane: 2, text: "long prompt", source: "discord", createdAt: 1_000,
      });
      queue.update(job, {
        status: "submitted", submittedAt: 1_000, nextAttemptAt: 0,
        echoCursor: { kind: "test", positions: {} },
      });
      const notices = [];
      const agent = slashAgent(() => false);
      const broker = createDeliveryBroker({
        agent, queue, now: () => clock, notify: async (_job, kind) => notices.push(kind),
      });
      return { rootDir, queue, job, notices, broker };
    }],
    when: ["the deadline fires", ({ broker }) => broker.kickTarget("lsrc", 2)],
    then: ["the warning is immediate and no watch is armed — prompt behavior is untouched", (_, ctx) => {
      expect(ctx.notices).toEqual(["unverified"]);
      const job = ctx.queue.read("lsrc", 2, ctx.job.id);
      expect(job.status).toBe("delivered_unverified");
      expect(job.lateEchoWatchUntil ?? null).toBe(null);
      expect(job.lastReason).toBe("submit attempt has no exact JSONL receipt after 60 minutes; delivery remains unverified");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });
});
