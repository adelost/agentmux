import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDriftGuard } from "./drift-guard.mjs";
import { loadReminderState, decideReminderAction } from "../core/reminder-state.mjs";
import { wakeDeliveryTarget } from "../core/delivery-wake.mjs";
import { readReminderActivity } from "../core/reminder-activity.mjs";
import { listAgents } from "../cli/config.mjs";
import { latestPaneStatesCached } from "../core/events.mjs";
import { readParkState } from "../core/pane-park.mjs";

vi.mock("../cli/config.mjs", () => ({ listAgents: vi.fn(), findChannelForPane: () => "fake-channel" }));
vi.mock("../core/reminder-activity.mjs", () => ({ readReminderActivity: vi.fn() }));
vi.mock("../core/events.mjs", async (original) => ({ ...await original(), latestPaneStatesCached: vi.fn() }));
vi.mock("../core/pane-park.mjs", () => ({ readParkState: vi.fn() }));

let root, statePath, agent, discord, broker, jobs;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "amux-drift-guard-")); statePath = join(root, "state.json");
  mkdirSync(join(root, ".agents/0"), { recursive: true });
  jobs = [];
  listAgents.mockReturnValue([{ name: "fixture", dir: root, panes: [{ cmd: "codex" }] }]);
  latestPaneStatesCached.mockReturnValue(new Map()); readParkState.mockReturnValue(null);
  readReminderActivity.mockReturnValue({ count: 45, latest: new Date().toISOString(), latestCompactTs: null });
  agent = { capturePane: vi.fn(async () => "› "), paneProcessState: vi.fn(async () => ({ running: true })), sendOnly: vi.fn() };
  discord = { send: vi.fn(async () => {}) };
  broker = { queue: { list: () => jobs }, enqueueAndWait: vi.fn(async (request) => {
    const job = { ...request, id: "fixture", status: "pending" }; jobs.push(job);
    return { delivered: false, pending: true, job };
  }) };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const guard = () => createDriftGuard({ agent, discord, deliveryBroker: broker, agentsYamlPath: "fixture",
  config: { enabled: true, turnThreshold: 40, activeWindowMs: 3600000, statePath }, log: () => {} });

describe("receipt-driven idle reminders", () => {
  it.each(["claude", "codex", "kimi-code"])("routes registered %s using its existing history seam", async (cmd) => {
    listAgents.mockReturnValue([{ name: "fixture", dir: root, panes: [{ cmd }] }]);
    await guard().tick();
    expect(readReminderActivity).toHaveBeenCalledWith(join(root, ".agents/0"), cmd, null);
    expect(broker.enqueueAndWait).toHaveBeenCalledOnce();
    expect(jobs[0].text).toContain(join(root, ".agents", cmd === "claude" ? "CLAUDE.md" : "AGENTS.md"));
  });
  it("does not receipt or duplicate a queued reminder, including after guard recreation", async () => {
    const g = guard(); await g.tick(); await g.tick(); await guard().tick();
    expect(broker.enqueueAndWait).toHaveBeenCalledOnce();
    expect(loadReminderState(statePath)).toEqual({}); expect(discord.send).not.toHaveBeenCalled();
    jobs[0].status = "acknowledged";
    await g.tick();
    expect(loadReminderState(statePath)["fixture:0"].reminderCount).toBe(1);
    expect(broker.enqueueAndWait).toHaveBeenCalledOnce();
  });
  it("receipts and mirrors an actual immediate ACK once", async () => {
    broker.enqueueAndWait.mockImplementation(async (request) => {
      const job = { ...request, status: "acknowledged" }; jobs.push(job); return { delivered: true, job };
    });
    const g = guard(); await g.tick();
    readReminderActivity.mockReturnValue({ count: 0, latest: null, latestCompactTs: null });
    await g.tick();
    expect(loadReminderState(statePath)["fixture:0"].reminderCount).toBe(1);
    expect(discord.send).toHaveBeenCalledOnce();
  });
  it("does not stack another rotation while an older reminder is pending", async () => {
    jobs.push({ source: "drift-guard", status: "submitted", idempotencyKey: "older-rotation" });
    await guard().tick(); expect(broker.enqueueAndWait).not.toHaveBeenCalled();
  });
  it("does not hammer terminal non-receipts, but new real work can retry", async () => {
    const g = guard(); await g.tick(); jobs[0].status = "cancelled";
    await g.tick(); expect(broker.enqueueAndWait).toHaveBeenCalledOnce();
    readReminderActivity.mockReturnValue({ count: 46, latest: new Date(Date.now() + 100).toISOString(), latestCompactTs: null });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 200);
    try { await g.tick(); expect(broker.enqueueAndWait).toHaveBeenCalledTimes(2); }
    finally { vi.restoreAllMocks(); }
    expect(loadReminderState(statePath)).toEqual({});
  });
  it("a fresh compact receipt resets the counter without sending", async () => {
    const compact = Date.now() - 10;
    readReminderActivity.mockReturnValue({ count: 100, latest: new Date().toISOString(), latestCompactTs: compact });
    await guard().tick();
    expect(broker.enqueueAndWait).not.toHaveBeenCalled();
    expect(loadReminderState(statePath)["fixture:0"].lastCompactTsMs).toBe(compact);
  });
  it("serializes overlapping ticks while delivery waits", async () => {
    let finish;
    broker.enqueueAndWait.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const g = guard(), first = g.tick();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await g.tick(); finish({ delivered: false }); await first;
    expect(broker.enqueueAndWait).toHaveBeenCalledOnce();
  });
  it.each(["working", "sleeping", "stale", "parked", "pushed-working", "modal", "no-broker"])("leaves %s panes alone", async (kind) => {
    if (kind === "working") agent.capturePane.mockResolvedValue("• Working (2s • esc to interrupt)");
    if (kind === "sleeping") agent.paneProcessState.mockResolvedValue({ running: false, shell: true });
    if (kind === "stale") readReminderActivity.mockReturnValue({ count: 500, latest: "2020-01-01T00:00:00Z" });
    if (kind === "parked") readParkState.mockReturnValue({ parked: true });
    if (kind === "pushed-working") latestPaneStatesCached.mockReturnValue(new Map([["fixture:0", { state: "working", ts: new Date().toISOString() }]]));
    if (kind === "modal") agent.capturePane.mockResolvedValue("Allow once\nDo you want to proceed?");
    const calls = broker.enqueueAndWait;
    if (kind === "no-broker") broker = null;
    await guard().tick(); expect(calls).not.toHaveBeenCalled(); expect(agent.sendOnly).not.toHaveBeenCalled();
  });
  it("vetoes every non-idle state, including newly recognized statuses", () => {
    for (const status of ["interrupted", "limited", "dismiss", "unknown", "new-state"]) {
      expect(decideReminderAction({ turnsSinceCutoff: 100, turnThreshold: 40, status,
        latestWorkTsMs: 100, nowMs: 200, activeWindowMs: 1000, runtimeState: { running: true } }).action).toBe("none");
    }
  });
  it("a queued reminder cannot later wake a stopped pane through the delivery broker", async () => {
    agent.paneProcessState.mockResolvedValue({ running: false, shell: true });
    agent.ensureReady = vi.fn(); const wakeGate = vi.fn(async () => ({ ok: true }));
    const result = await wakeDeliveryTarget({ agent, job: { source: "drift-guard", agentName: "fixture", pane: 0 },
      wakeGate, queue: { update: (job, update) => ({ ...job, ...update }) }, now: () => 100,
      retryMs: () => 1000, queueEvent: () => {}, notifyBlocked: async (job) => job });
    expect(result.proceed).toBe(false); expect(result.job.lastReason).toContain("cannot wake");
    expect(wakeGate).not.toHaveBeenCalled(); expect(agent.ensureReady).not.toHaveBeenCalled();
  });
});
