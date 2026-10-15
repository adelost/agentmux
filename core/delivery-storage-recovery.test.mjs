import { component, expect, feature } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";

const faults = vi.hoisted(() => ({ receipt: false, paneLease: false }));
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal();
  return { ...fs, writeFileSync(path, data, ...args) {
    if (faults.receipt && String(data).includes('"status": "acknowledged"')) {
      faults.receipt = false;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return fs.writeFileSync(path, data, ...args);
  }, writeSync(fd, ...args) {
    if (faults.paneLease && fs.readlinkSync(`/proc/self/fd/${fd}`).endsWith(".consumer.lock")) {
      faults.paneLease = false;
      throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    }
    return fs.writeSync(fd, ...args);
  } };
});

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-storage-recovery-"));
  const clock = { value: Date.now() };
  const now = () => clock.value;
  const queue = createDeliveryQueue({ rootDir, now });
  const echoed = new Set(), sends = [], logs = [], receiptWaits = [];
  const agent = {
    capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
    waitForPromptEcho: async (_name, _pane, text) => echoed.has(text),
    dismissBlockingPrompt: async () => {},
    sendOnly: async (_name, text, pane, options) => {
      sends.push(pane);
      await options.onDrafted?.();
      await options.onSubmitting?.();
      await options.onSubmitted?.();
      echoed.add(text);
      return { submitted: true };
    },
  };
  const broker = createDeliveryBroker({ agent, queue, now, log: message => logs.push(message) });
  const first = queue.enqueue({ agentName: "api", pane: 5, text: "first" });
  const human = queue.enqueue({ agentName: "api", pane: 0, text: "human", source: "discord" });
  return { rootDir, queue, agent, broker, first, human, sends, logs, receiptWaits, clock };
}

feature("delivery storage failure recovery", () => {
  component("a failed receipt write releases the session and retries the exact receipt", {
    given: ["api:5 can see its receipt but its acknowledgement write fails once", () => {
      const ctx = fixture();
      faults.receipt = true;
      return ctx;
    }],
    when: ["the write fails, a human reaches api:0, and the next round checks api:5", async ctx => {
      const failure = await ctx.broker.kickTarget("api", 5).catch(error => error);
      const afterFailure = ctx.queue.read("api", 5, ctx.first.id).status;
      await ctx.broker.kickTarget("api", 0);
      const sibling = ctx.queue.read("api", 0, ctx.human.id).status;
      const beforeRetry = ctx.queue.read("api", 5, ctx.first.id).status;
      ctx.clock.value += 1_001;
      await ctx.broker.kickTarget("api", 5);
      return { failure, afterFailure, sibling, beforeRetry };
    }],
    then: ["the failure is loud, the sibling passes, and no prompt is sent twice", (result, ctx) => {
      try {
        expect(result.failure.code).toBe("ENOSPC");
        expect(result.afterFailure).toBe("submitted");
        expect(result.beforeRetry).toBe("submitted");
        expect(result.sibling).toBe("acknowledged");
        expect(ctx.queue.read("api", 5, ctx.first.id).status).toBe("acknowledged");
        expect(ctx.sends).toEqual([5, 0]);
        expect(ctx.logs.some(line => line.includes("ENOSPC") && line.includes(ctx.first.id))).toBe(true);
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });

  component("a pane lock write failure cannot leak its already-acquired session lock", {
    given: ["the pane lease metadata write fails after the session lease was acquired", () => {
      const ctx = fixture();
      faults.paneLease = true;
      return ctx;
    }],
    when: ["the failed acquisition is followed by a sibling and a retry", async ctx => {
      const failure = await ctx.broker.kickTarget("api", 5).catch(error => error);
      await ctx.broker.kickTarget("api", 0);
      await ctx.broker.kickTarget("api", 5);
      return failure;
    }],
    then: ["both jobs recover in the same broker without a leaked kernel flock", (failure, ctx) => {
      try {
        expect(failure.code).toBe("ENOSPC");
        expect(ctx.queue.read("api", 0, ctx.human.id).status).toBe("acknowledged");
        expect(ctx.queue.read("api", 5, ctx.first.id).status).toBe("acknowledged");
        expect(ctx.sends).toEqual([0, 5]);
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });

  component("a submitted pane does not hold siblings while waiting for its receipt", {
    given: ["api:5 has submitted but its JSONL receipt is not yet visible", () => {
      const ctx = fixture();
      const check = ctx.agent.waitForPromptEcho;
      ctx.agent.waitForPromptEcho = async (name, pane, text, timeout) => {
        if (pane === 5) ctx.receiptWaits.push(timeout);
        return pane === 5 ? false : check(name, pane, text);
      };
      return ctx;
    }],
    when: ["both panes are drained", async ctx => {
      await ctx.broker.kickTarget("api", 5);
      await ctx.broker.kickTarget("api", 0);
    }],
    then: ["the human passes without any blocking receipt wait", (_, ctx) => {
      try {
        expect(ctx.queue.read("api", 5, ctx.first.id).status).toBe("submitted");
        expect(ctx.queue.read("api", 0, ctx.human.id).status).toBe("acknowledged");
        expect(ctx.receiptWaits.every(timeout => timeout === 0)).toBe(true);
      } finally { rmSync(ctx.rootDir, { recursive: true, force: true }); }
    }],
  });
});
