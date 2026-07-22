import { expect, feature, component } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { createDeliveryBroker } from "./delivery-broker.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";

feature("durable delivery wakes through the sleep lifecycle", () => {
  component("a stopped target is prepared and completed before its prompt is submitted", {
    given: ["one queued prompt and a stopped pane", () => {
      const rootDir = mkdtempSync(join(tmpdir(), "amux-sleep-delivery-"));
      const queue = createDeliveryQueue({ rootDir });
      queue.enqueue({ agentName: "lsrc", pane: 3, text: "wake work" });
      const order = [];
      const agent = {
        paneProcessState: vi.fn(async () => order.includes("start")
          ? { running: true }
          : { running: false, shell: true }),
        ensureReady: vi.fn(async () => { order.push("start"); }),
        capturePromptEchoCursor: vi.fn(async () => ({ kind: "test", positions: {} })),
        sendOnly: vi.fn(async () => {
          order.push("send");
          return { submitted: true, tuiHint: "empty" };
        }),
        waitForPromptEcho: vi.fn(async () => order.includes("send")),
        isBusy: vi.fn(async () => false),
        promptTransportState: vi.fn(async () => ({ state: "empty-idle", busy: false })),
        dismissBlockingPrompt: vi.fn(async () => {}),
        hasResponseForPrompt: vi.fn(() => false),
      };
      const wakeLifecycle = {
        prepare: vi.fn(async () => {
          order.push("prepare");
          return { ok: true, tracked: true, sleepGeneration: 4, sessionId: "exact" };
        }),
        complete: vi.fn(async () => {
          order.push("complete");
          return { ok: true };
        }),
      };
      const broker = createDeliveryBroker({
        agent,
        queue,
        intervalMs: 60_000,
        wakeAdmission: async () => ({ ok: true, reason: "ok" }),
        wakeLifecycle,
        notify: async () => {},
      });
      return { rootDir, queue, order, agent, wakeLifecycle, broker };
    }],
    when: ["draining once", async (ctx) => {
      await ctx.broker.kick();
      ctx.broker.stop();
      return ctx;
    }],
    then: ["exact wake completes before the one pane write", (ctx) => {
      expect(ctx.order.slice(0, 4)).toEqual(["prepare", "start", "complete", "send"]);
      expect(ctx.wakeLifecycle.prepare).toHaveBeenCalledOnce();
      expect(ctx.wakeLifecycle.complete).toHaveBeenCalledOnce();
      expect(ctx.queue.list("lsrc", 3)[0].status).toBe("acknowledged");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a lifecycle refusal leaves the prompt pending and never starts the pane", {
    given: ["one stopped target with wrong-session refusal", () => {
      const rootDir = mkdtempSync(join(tmpdir(), "amux-sleep-delivery-refuse-"));
      const queue = createDeliveryQueue({ rootDir });
      queue.enqueue({ agentName: "lsrc", pane: 3, text: "preserve me" });
      const agent = {
        paneProcessState: vi.fn(async () => ({ running: false, shell: true })),
        ensureReady: vi.fn(async () => {}),
      };
      const broker = createDeliveryBroker({
        agent,
        queue,
        intervalMs: 60_000,
        wakeAdmission: async () => ({ ok: true }),
        wakeLifecycle: {
          prepare: async () => ({ ok: false, reason: "sleep-session-mismatch" }),
        },
        notify: async () => {},
      });
      return { rootDir, queue, agent, broker };
    }],
    when: ["draining once", async (ctx) => {
      await ctx.broker.kick();
      ctx.broker.stop();
      return ctx;
    }],
    then: ["the payload remains durable and no process starts", (ctx) => {
      const job = ctx.queue.list("lsrc", 3)[0];
      expect(job.status).toBe("pending");
      expect(job.lastReason).toBe("wake-refused:sleep-session-mismatch");
      expect(ctx.agent.ensureReady).not.toHaveBeenCalled();
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });
});
