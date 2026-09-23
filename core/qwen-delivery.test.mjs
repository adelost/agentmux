import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { createDeliveryBroker } from "./delivery-broker.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";

const cursor = (generation) => ({
  kind: "qwen-dual-output-v1", generation, sessionId: "exact-session", positions: {},
});

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-qwen-delivery-"));
  const queue = createDeliveryQueue({ rootDir });
  const job = queue.enqueue({ agentName: "claw", pane: 8, text: "create a cube", source: "cli" });
  return { rootDir, queue, job };
}

feature("Qwen delivery across process generations", () => {
  for (const priorGeneration of ["old", "missing"]) component(
    `a wake captures the live generation after a ${priorGeneration} Qwen cursor`, {
    given: ["an idle Qwen pane whose wake starts a new generation", () => {
      const ctx = fixture();
      let running = false;
      let generation = "old";
      let sends = 0;
      let accepted = false;
      const agent = {
        paneProcessState: async () => ({ running, dead: !running }),
        ensureReady: async () => { running = true; generation = "new"; },
        capturePromptEchoCursor: async () =>
          priorGeneration === "missing" && !running ? null : cursor(generation),
        waitForPromptEcho: async (_name, _pane, _text, _ms, options) =>
          accepted && options?.cursor?.generation === generation,
        dismissBlockingPrompt: async () => null,
        sendOnly: async (_name, _text, _pane, options) => {
          sends++;
          await options.onSubmitting?.();
          accepted = true;
          await options.onSubmitted?.();
          return { submitted: true };
        },
      };
      ctx.broker = createDeliveryBroker({
        agent, queue: ctx.queue, wakeAdmission: async () => ({ ok: true }),
      });
      ctx.sends = () => sends;
      return ctx;
    }],
    when: ["the queued prompt is sent once", ({ broker }) => broker.kickTarget("claw", 8)],
    then: ["the new generation acknowledges it without a second send", (_, ctx) => {
      expect(ctx.queue.read("claw", 8, ctx.job.id)).toMatchObject({
        status: "acknowledged", attempts: 1,
        echoCursor: { generation: "new" },
      });
      expect(ctx.sends()).toBe(1);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("a Qwen submit without a receipt is never resent on an idle screen", {
    given: ["a two-minute-old submitted prompt with an ambiguous receipt", () => {
      const ctx = fixture();
      ctx.queue.update(ctx.job, {
        status: "submitted", attempts: 1, submittedAt: 1_000,
        echoCursor: cursor("old"), nextAttemptAt: 0,
      });
      let restarts = 0;
      let sends = 0;
      const agent = {
        waitForPromptEcho: async () => false,
        paneProcessState: async () => ({ running: true }),
        promptTransportState: async () => ({ state: "empty-idle", busy: false, dialect: "qwen" }),
        restartPaneExact: async () => { restarts++; return { ok: true, dialect: "qwen" }; },
        sendOnly: async () => { sends++; return { submitted: true }; },
      };
      ctx.broker = createDeliveryBroker({ agent, queue: ctx.queue, now: () => 130_000 });
      ctx.counts = () => ({ restarts, sends });
      return ctx;
    }],
    when: ["the broker checks the idle pane", ({ broker }) => broker.kickTarget("claw", 8)],
    then: ["the submit fence survives without restarting or retyping", (_, ctx) => {
      expect(ctx.queue.read("claw", 8, ctx.job.id)).toMatchObject({
        status: "submitted", attempts: 1,
      });
      expect(ctx.counts()).toEqual({ restarts: 0, sends: 0 });
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });
});
