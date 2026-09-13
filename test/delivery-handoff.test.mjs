import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createDeliveryBroker } from "../core/delivery-broker.mjs";
import { deliveryQueueDisplayRows } from "../cli/queue-format.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-handoff-"));
  roots.push(rootDir);
  let clock = 60_000, running = false, admitted = false, receipt = false;
  const queue = createDeliveryQueue({ rootDir, now: () => clock });
  const writes = [], notices = [];
  const agent = {
    paneProcessState: async () => ({ running, shell: !running }),
    ensureReady: async () => { running = true; },
    capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
    waitForPromptEcho: async () => receipt,
    dismissBlockingPrompt: async () => null,
    sendOnly: async (_name, text, _pane, options) => {
      writes.push(text);
      await options.onPasteStarted?.();
      await options.onDrafted?.();
      await options.onSubmitting?.();
      await options.onSubmitted?.();
      receipt = true;
      return { submitted: true };
    },
  };
  const notify = async (job, kind) => notices.push({ id: job.id, kind });
  const brokerOptions = { agent, queue, now: () => clock, notify, log: () => {},
    wakeAdmission: async () => admitted ? { ok: true } : { ok: false, reason: "identity-linked-checkout" } };
  const job = queue.enqueue({ agentName: "worker", pane: 6, text: "Finish the existing task",
    source: "cli", metadata: { sender: "owner:4", channelId: "worker-channel" } });
  return { rootDir, queue, agent, job, writes, notices, brokerOptions,
    broker: createDeliveryBroker(brokerOptions),
    advance: (ms) => { clock += ms; },
    heal: () => { admitted = true; },
    receipt: () => { receipt = true; },
    read: () => queue.read("worker", 6, job.id),
    callbacks: () => queue.list("owner", 4),
  };
}

describe("blocked handoffs return to their actual sender", () => {
  it("reports two refused wakes once across restart, without moving or losing the task", async () => {
    // Given the overnight incident: a stopped worker and an invalid AMUX installation.
    const f = fixture();
    await f.broker.kickTarget("worker", 6);
    expect(f.callbacks()).toHaveLength(0);
    f.advance(3_001);
    await f.broker.kickTarget("worker", 6);
    // When the next observation sees two actual refusals, notify only this sender.
    f.advance(1_000);
    await f.broker.kickTarget("worker", 6);
    const callback = f.callbacks()[0];
    expect(callback).toMatchObject({ source: "delivery-recovery", status: "pending" });
    expect(callback.text).toContain(f.job.id);
    expect(callback.text).toContain("AMUX-installationen");
    expect(callback.text).toContain("inte projektets arbetskopia");
    const reopened = createDeliveryQueue({ rootDir: f.rootDir });
    await createDeliveryBroker({ ...f.brokerOptions, queue: reopened }).kickTarget("worker", 6);
    // Then the exact job is still pending, with no keystrokes and one durable callback.
    expect(reopened.list("owner", 4)).toHaveLength(1);
    expect(f.read()).toMatchObject({ status: "pending", text: f.job.text, attempts: 2 });
    expect(f.writes).toEqual([]);
    f.advance(60_000);
    f.heal();
    await f.broker.kickTarget("worker", 6);
    expect(f.read().status).toBe("acknowledged");
    expect(f.writes).toEqual([f.job.text]);
  });

  it("does not notify the sender when the first refusal heals before the next attempt", async () => {
    // Given one transient refusal, when admission heals, then the original delivers once.
    const f = fixture();
    await f.broker.kickTarget("worker", 6);
    f.advance(3_001);
    f.heal();
    await f.broker.kickTarget("worker", 6);
    expect(f.read().status).toBe("acknowledged");
    expect(f.callbacks()).toHaveLength(0);
    expect(f.writes).toEqual([f.job.text]);
  });

  it("reports a ten-minute pre-submit stall but not ordinary queue waiting", async () => {
    const f = fixture();
    // Given an old follower with no attempt, age alone must not wake the sender.
    f.advance(600_000);
    f.queue.update(f.job, { nextAttemptAt: 900_000 });
    await f.broker.kickTarget("worker", 6);
    expect(f.callbacks()).toHaveLength(0);
    // When a real failed attempt has been unresolved for ten minutes, then report it.
    f.queue.update(f.job, { attempts: 1, firstAttemptAt: 60_000, lastAttemptAt: 60_000,
      lastReason: "foreign composer preserved", nextAttemptAt: 900_000 });
    await f.broker.kickTarget("worker", 6);
    expect(f.callbacks()).toHaveLength(1);
    expect(f.read().status).toBe("pending");
    expect(f.writes).toEqual([]);
  });

  it.each(["submitted", "submitting", "drafted", "pasting"])("never treats %s as permission to reassign", async (status) => {
    const f = fixture();
    // Given a physical write or ambiguous submit, even an old wake reason is not authority.
    f.advance(600_000);
    f.queue.update(f.job, { status, attempts: 2, firstAttemptAt: 60_000,
      lastReason: "wake-refused:identity-linked-checkout", nextAttemptAt: 900_000 });
    // When the broker inspects the lane, then there is no new task or owner prompt.
    await f.broker.kickTarget("worker", 6);
    expect(f.callbacks()).toHaveLength(0);
    expect(f.read().status).toBe(status);
    expect(f.writes).toEqual([]);
  });

  it("lets a late exact receipt beat a stale handoff alert", async () => {
    const f = fixture();
    // Given a due alert whose exact receipt has just arrived.
    f.queue.update(f.job, { attempts: 2, firstAttemptAt: 60_000, echoNotBeforeMs: 60_000,
      lastReason: "wake-refused:identity-linked-checkout", nextAttemptAt: 900_000 });
    f.receipt();
    // When checked at the notification boundary, then acknowledge rather than notify.
    await f.broker.kickTarget("worker", 6);
    expect(f.callbacks()).toHaveLength(0);
    expect(f.read().status).toBe("acknowledged");
  });

  it.each(["delivery-recovery", "discord", "native"])("never turns a %s job into a recursive or ambiguous recovery prompt", async (source) => {
    const f = fixture();
    // Given a callback, human message or native operation, not a new tmux handoff.
    f.queue.update(f.job, { source: source === "native" ? "cli" : source,
      attempts: 2, firstAttemptAt: 60_000, nextAttemptAt: 900_000,
      lastReason: "wake-refused:identity-linked-checkout" });
    if (source === "native") f.agent.isNativeTarget = () => true;
    // When inspected, then no arbitrary owner is awakened.
    await f.broker.kickTarget("worker", 6);
    expect(f.callbacks()).toHaveLength(0);
    expect(f.writes).toEqual([]);
  });

  it("survives a crash-shaped storage gap between callback enqueue and parent receipt", async () => {
    const f = fixture();
    // Given a callback that reaches disk before the parent's bookkeeping write fails.
    f.queue.update(f.job, { attempts: 2, firstAttemptAt: 60_000, nextAttemptAt: 900_000,
      lastReason: "wake-refused:identity-linked-checkout" });
    const update = f.queue.update;
    let failOnce = true;
    f.queue.update = (job, patch) => {
      if (patch.metadata?.handoffNoticeJobId && failOnce) {
        failOnce = false;
        throw new Error("storage temporarily unavailable");
      }
      return update(job, patch);
    };
    await f.broker.kickTarget("worker", 6);
    const originalCallback = f.callbacks()[0];
    expect(originalCallback).toBeDefined();
    // When the restarted broker retries, then the same durable callback is reused.
    f.advance(60_000);
    const reopened = createDeliveryQueue({ rootDir: f.rootDir });
    await createDeliveryBroker({ ...f.brokerOptions, queue: reopened }).kickTarget("worker", 6);
    expect(reopened.list("owner", 4)).toHaveLength(1);
    expect(reopened.list("owner", 4)[0].text).toBe(originalCallback.text);
    expect(f.read().metadata.handoffNoticeJobId).toBe(originalCallback.id);
  });

  it("keeps a failed park warning retryable and preserves the original blocker and attempt count", async () => {
    const f = fixture();
    let calls = 0;
    const notify = async () => { if (++calls === 1) throw new Error("Discord unavailable"); };
    const broker = createDeliveryBroker({ ...f.brokerOptions, notify });
    // Given an exhausted head and a notification transport outage.
    f.queue.update(f.job, { attempts: 64, firstAttemptAt: 60_000,
      lastReason: "wake-refused:identity-linked-checkout" });
    f.advance(3_600_000);
    await broker.kickTarget("worker", 6);
    expect(f.read().noticeSentAt).toBeNull();
    expect(f.read().lastReason).toBe("wake-refused:identity-linked-checkout");
    expect(deliveryQueueDisplayRows([f.read()])[0].attempts).toBe(64);
    // When a replacement broker can notify, even inside the park window, retry the warning.
    f.advance(60_000);
    await createDeliveryBroker({ ...f.brokerOptions, notify }).kickTarget("worker", 6);
    expect(f.read().noticeSentAt).toBeGreaterThan(0);
    expect(calls).toBe(2);
    expect(f.read().status).toBe("pending");
    expect(f.writes).toEqual([]);
  });
});
