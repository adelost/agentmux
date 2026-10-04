import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";

feature("a proven exact-session recovery still gets its authorized attempt", () => {
  component("an eight-hour-old recovered submit does not park the FIFO forever", {
    given: ["a recovered pending head, a waiting human message and an accepting restored pane", () => {
      const rootDir = mkdtempSync(join(tmpdir(), "amux-recovered-age-"));
      const now = () => 9 * 3_600_000;
      const queue = createDeliveryQueue({ rootDir, now });
      const head = queue.enqueue({ agentName: "lsrc", pane: 0, text: "old exact prompt", orderKey: "001" });
      queue.update(head, { status: "pending", attempts: 1, firstAttemptAt: 3_600_000,
        lastAttemptAt: 3_600_000, nextAttemptAt: now(), submittedAt: null, submitFenceAt: null,
        metadata: { submittedRecoveryAt: now(), submittedRecoveryKind: "dead-process-resend" } });
      const follower = queue.enqueue({ agentName: "lsrc", pane: 0, text: "current human request", orderKey: "002" });
      const echoed = new Set(), sends = [];
      const agent = {
        capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
        waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
        dismissBlockingPrompt: async () => null,
        sendOnly: async (_name, text, _pane, options = {}) => {
          sends.push(text);
          await options.onPasteStarted?.(); await options.onDrafted?.();
          await options.onSubmitting?.(); await options.onSubmitted?.();
          echoed.add(text);
          return { submitted: true, queued: false };
        },
        sendEnter: async () => {}, capturePane: async () => "› ",
      };
      const broker = createDeliveryBroker({ agent, queue, now, notify: async () => {} });
      return { rootDir, queue, head, follower, sends, broker };
    }],
    when: ["the existing broker drains twice without any producer resend", async ({ broker }) => {
      await broker.kickTarget("lsrc", 0);
      await broker.kickTarget("lsrc", 0);
    }],
    then: ["both immutable messages are received exactly once, in order", (_, ctx) => {
      try {
        expect(ctx.sends).toEqual(["old exact prompt", "current human request"]);
        expect(ctx.queue.read("lsrc", 0, ctx.head.id).status).toBe("acknowledged");
        expect(ctx.queue.read("lsrc", 0, ctx.follower.id).status).toBe("acknowledged");
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });
});
