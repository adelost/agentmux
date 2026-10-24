import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../core/state.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { QUOTA_FLOOR_ALERT_STATE } from "../core/quota-floor-alert.mjs";
import { createQuotaFloorAlertRuntime } from "./quota-floor-alert.mjs";
import { createQuotaCompactionEvidence } from "./quota-floor-evidence.mjs";

describe("the real queue adapter sends only the notice and follows its receipt", () => {
  it("aggregates actual queue jobs and reads the ordinary ACK without replaying held work", async () => {
    const root = mkdtempSync(join(tmpdir(), "quota-runtime-")), start = Date.now() - 31 * 60000;
    const queue = createDeliveryQueue({ rootDir: join(root, "queue") });
    const state = createState(join(root, "state.json"));
    const original = queue.enqueue({ agentName: "claw", pane: 2, text: "private held product work" });
    queue.update(original, { lastReason: "wake-refused:quota-floor: Claude A held", costHold: true });
    let humanCalls = 0;
    const runtime = createQuotaFloorAlertRuntime({ queue, state, configPath: join(root, "agents.yaml"),
      notifyHuman: async (text, options) => {
        humanCalls++; expect(text).not.toContain("private held product work");
        expect(options.strictSingleAttempt).toBe(true); return { sent: true, messageId: "dm-proof", channelId: "dm" };
      },
      readSnapshot: async () => ({ accounts: [{ name: "Claude A", provider: "claude", ok: true,
        account: { email: "test@example.test" }, inUse: ["claw:2"],
        observation: { observedAt: new Date().toISOString() },
        limits: [{ kind: "weekly_all", usedPercent: 97, resetsAt: new Date(Date.now() + 86400000).toISOString() }] }] }),
      events: () => [{ event: "delivery_queue", state: "wake_refused", jobId: original.id,
        reason: "quota-floor: Claude A held", ts: new Date(start).toISOString() }], compactions: () => ({}), log: () => {} });
    await runtime.tick();
    const notices = queue.list("lsrc", 3);
    expect(notices).toHaveLength(1); expect(notices[0].source).toBe("quota-floor-alert");
    expect(queue.read("claw", 2, original.id).status).toBe("pending");
    expect(queue.read("claw", 2, original.id).submittedAt ?? null).toBeNull();
    queue.update(notices[0], { status: "acknowledged", acknowledgedAt: Date.now() });
    await runtime.tick(); expect(humanCalls).toBe(1); expect(queue.list("lsrc", 3)).toHaveLength(1);
    expect(Object.values(state.get(QUOTA_FLOOR_ALERT_STATE).accounts)[0].receipts.dispatcher.status).toBe("delivered");
  });
  it("backfills only a proven held notice, never a compact warning or unrelated text", () => {
    const root = mkdtempSync(join(tmpdir(), "quota-hold-history-"));
    const read = createQuotaCompactionEvidence({ configPath: join(root, "agents.yaml"), posts: () => ({ posts: [
      { id: "warning", ts: new Date().toISOString(), status: "sent", text: "Auto-compact in 60s: **claw:2**" },
      { id: "hold-proof", kind: "notice", agent: "claw", pane: 2, ts: "2026-10-24T03:44:53.699Z", status: "sent",
        text: "Auto-compact of **claw:2** is held: the compact was refused: context-cost:delivery-pending. Its prompt cache goes cold at 05:48." },
      { id: "failed", ts: new Date().toISOString(), status: "failed", text: "Auto-compact of **claw:3** is held: context-cost:delivery-pending" },
    ] }) });
    const result = read([{ agentName: "claw" }]);
    expect(result["claw:2"]).toMatchObject({ source: "conversation:hold-proof", observedAt: Date.parse("2026-10-24T03:44:53.699Z"), lastActivityMs: null });
    expect(result["claw:3"]).toBeUndefined();
  });
});
