import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "./state.mjs";
import { createQuotaFloorAlert, QUOTA_FLOOR_ALERT_STATE, quotaAlertCodexCapacity } from "./quota-floor-alert.mjs";

const START = Date.parse("2026-10-24T00:38:00Z");
function world() {
  const path = join(mkdtempSync(join(tmpdir(), "quota-floor-alert-")), "state.json");
  const w = { now: START, path, reset: START + 7 * 86400000, used: 97, ok: true,
    jobs: [{ id: "head", agentName: "claw", pane: 2, status: "pending", createdAt: START - 9999999,
      lastReason: "wake-refused:quota-floor: Claude A is held" },
    { id: "tail", agentName: "claw", pane: 2, status: "pending" },
    { id: "other", agentName: "claw", pane: 0, status: "pending", lastReason: "wake-refused:quota-floor: held" }],
    refusals: [{ jobId: "head", at: START }, { jobId: "other", at: START }], compactions: {},
    human: vi.fn(async () => ({ sent: true, messageId: "human-message", channelId: "dm" })),
    dispatcher: vi.fn(async () => ({ jobId: "dispatcher-job" })), lookup: vi.fn(() => null) };
  w.snapshot = () => ({ accounts: [{ provider: "claude", name: "Claude A", ok: w.ok,
    account: { email: "synthetic@example.test" }, inUse: ["claw:2", "claw:0"],
    observation: { observedAt: new Date(w.observed ?? w.now).toISOString() },
    limits: [{ kind: "weekly_all", usedPercent: w.used, resetsAt: new Date(w.reset).toISOString() }] }] });
  w.controller = () => createQuotaFloorAlert({ state: createState(path), now: () => w.now,
    readEvidence: async () => ({ snapshot: w.snapshot(), jobs: w.jobs, refusals: w.refusals, compactions: w.compactions }),
    notifyHuman: w.human, notifyDispatcher: w.dispatcher, lookupDispatcher: w.lookup });
  w.data = () => Object.values(createState(path).get(QUOTA_FLOOR_ALERT_STATE).accounts)[0];
  return w;
}

describe("one durable notification per account's continuous floor hold", () => {
  it("uses first refusal rather than job age, strictly after 30 minutes, aggregating queued jobs", async () => {
    const w = world(), c = w.controller();
    await c.tick(); expect(w.human).not.toHaveBeenCalled();
    w.now += 30 * 60000; await c.tick(); expect(w.human).not.toHaveBeenCalled();
    w.now++; await c.tick();
    expect(w.human).toHaveBeenCalledTimes(1); expect(w.dispatcher).toHaveBeenCalledTimes(1);
    expect(w.human.mock.calls[0][0]).toContain("3 jobb väntar i 2 paneler");
    expect(w.data().firstRefusedAt).toBe(START);
    expect(w.data().receipts).toMatchObject({ human: { status: "delivered", messageId: "human-message" }, dispatcher: { status: "queued" } });
  });
  it("survives restart, reset jitter, more retries/jobs and reconciles only the real dispatcher ACK", async () => {
    const w = world(); w.now += 31 * 60000; await w.controller().tick();
    const id = w.data().id; w.reset += 455; w.jobs.push({ id: "more", agentName: "claw", pane: 2, status: "pending" });
    w.lookup.mockReturnValue({ id: "dispatcher-job", status: "acknowledged", acknowledgedAt: w.now });
    await w.controller().tick();
    expect(w.human).toHaveBeenCalledTimes(1); expect(w.dispatcher).toHaveBeenCalledTimes(1);
    expect(w.data().id).toBe(id); expect(w.data().jobs).toHaveLength(4);
    expect(w.data().receipts.dispatcher.status).toBe("delivered");
  });
  it("preserves unknown human results across restart while delivering to the dispatcher", async () => {
    const w = world(); w.now += 31 * 60000; w.human.mockRejectedValue(Error("lost response"));
    await w.controller().tick(); await w.controller().tick();
    expect(w.data().receipts.human.status).toBe("unknown");
    expect(w.human).toHaveBeenCalledTimes(1); expect(w.dispatcher).toHaveBeenCalledTimes(1);
  });
  it("an interrupted durable intent cannot become a second human send", async () => {
    const w = world(); w.now += 31 * 60000; await w.controller().tick();
    createState(w.path).updateKey(QUOTA_FLOOR_ALERT_STATE, data => {
      Object.values(data.accounts)[0].receipts.human = { status: "attempting", at: w.now }; return data;
    });
    await w.controller().tick(); expect(w.human).toHaveBeenCalledTimes(1);
    expect(w.data().receipts.human.status).toBe("unknown");
  });
  it("a proven not-sent recipient can retry without repeating the confirmed recipient", async () => {
    const w = world(); w.now += 31 * 60000;
    w.human.mockResolvedValueOnce({ outcome: "not-sent" });
    await w.controller().tick(); await w.controller().tick();
    expect(w.human).toHaveBeenCalledTimes(2); expect(w.dispatcher).toHaveBeenCalledTimes(1);
  });
  it("unknown quota does not recover an episode and unknown reset remains explicit", async () => {
    const w = world(); w.now += 31 * 60000; w.ok = false;
    await w.controller().tick();
    expect(w.data().status).toBe("held"); expect(w.human.mock.calls[0][0]).toContain("Återställning unknown");
    expect(w.human.mock.calls[0][0]).toContain("Codex-kapacitet: unknown");
  });
  it("only a genuine recovery followed by new refusal starts the second episode", async () => {
    const w = world(); w.now += 31 * 60000; await w.controller().tick(); const id = w.data().id;
    w.now += 60000; w.used = 10; await w.controller().tick(); expect(w.data().status).toBe("recovered");
    w.now += 3600000; w.used = 97; w.refusals = w.refusals.map(row => ({ ...row, at: w.now }));
    await w.controller().tick(); expect(w.data().firstRefusedAt).toBe(w.now);
    expect(w.human).toHaveBeenCalledTimes(1);
    w.now += 31 * 60000; await w.controller().tick();
    expect(w.data().id).not.toBe(id); expect(w.human).toHaveBeenCalledTimes(2);
  });
  it("never counts or mutates submitted/UNKNOWN jobs", async () => {
    const w = world(); w.jobs[0].submittedAt = START; w.jobs[0].status = "submitted";
    w.jobs[2].status = "delivered_unverified"; const original = structuredClone(w.jobs);
    w.now += 3600000; await w.controller().tick();
    expect(w.human).not.toHaveBeenCalled(); expect(w.jobs).toEqual(original);
  });
  it("adds a sourced compaction wait inside the same episode without a second alert", async () => {
    const w = world(); w.now += 31 * 60000;
    w.compactions["claw:2"] = { cause: "context-cost:delivery-pending", observedAt: w.now - 1000,
      lastActivityMs: w.now - 55 * 60000, cacheExpiresAt: w.now + 5 * 60000 };
    await w.controller().tick();
    expect(w.human.mock.calls[0][0]).toContain("compaction waiting for quota-held delivery");
    expect(w.human.mock.calls[0][0]).toContain("cacheålder 55 min");
    await w.controller().tick(); expect(w.human).toHaveBeenCalledTimes(1);
  });
  it("serializes overlapping heartbeat ticks", async () => {
    const w = world(); w.now += 31 * 60000; const c = w.controller();
    await Promise.all([c.tick(), c.tick(), c.tick()]); expect(w.human).toHaveBeenCalledTimes(1);
  });
  it("two controllers sharing durable state claim each recipient only once", async () => {
    const w = world(); w.now += 31 * 60000;
    await Promise.all([w.controller().tick(), w.controller().tick()]);
    expect(w.human).toHaveBeenCalledTimes(1); expect(w.dispatcher).toHaveBeenCalledTimes(1);
  });
  it("keeps reconciling the dispatcher receipt after the quota episode recovers", async () => {
    const w = world(); w.now += 31 * 60000; await w.controller().tick();
    w.used = 0; w.now += 60000; w.jobs = [];
    w.lookup.mockReturnValue({ id: "dispatcher-job", status: "acknowledged", acknowledgedAt: w.now });
    await w.controller().tick();
    expect(w.data().status).toBe("recovered");
    expect(w.data().receipts.dispatcher.status).toBe("delivered");
    expect(w.dispatcher).toHaveBeenCalledTimes(1);
  });
  it("old refusal rows cannot backdate a second episode after recovery", async () => {
    const w = world(); w.now += 31 * 60000; await w.controller().tick();
    w.used = 0; w.now += 60000; await w.controller().tick();
    w.now += 3600000; w.used = 97;
    w.refusals.push({ jobId: "head", at: w.now });
    await w.controller().tick(); expect(w.data().firstRefusedAt).toBe(w.now);
  });
});

describe("Codex capacity is measured in both windows", () => {
  it("rejects missing, stale, exhausted or reset-past windows", () => {
    const a = { name: "Codex W", provider: "codex", ok: true,
      observation: { observedAt: new Date(START).toISOString() },
      limits: [{ limitId: "codex", windows: [300,10080].map(windowMinutes => ({ windowMinutes,
        usedPercent: 22, resetsAt: new Date(START + 86400000).toISOString() })) }] };
    expect(quotaAlertCodexCapacity([a], START)).toMatchObject([{ sessionLeft: 78, weekLeft: 78 }]);
    expect(quotaAlertCodexCapacity([a], START + 11 * 60000)).toEqual([]);
    a.limits[0].windows[0].usedPercent = 100; expect(quotaAlertCodexCapacity([a], START)).toEqual([]);
    a.limits[0].windows.shift(); expect(quotaAlertCodexCapacity([a], START)).toEqual([]);
  });
});
