import { afterEach, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "../core/state.mjs";
import { createContextMaintenance } from "../core/context-maintenance.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createDeliveryBroker } from "../core/delivery-broker.mjs";
import { composerAgent } from "./fixtures/composer-agent.mjs";

const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture({ refuses = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "warm-quota-compact-")); roots.push(root);
  const path = join(root, "native.jsonl"), statePath = join(root, "state.json"), now = Date.now();
  writeFileSync(path, ""); const state = createState(statePath);
  const jobs = [{ id: "original-job", agentName: "fixture", pane: 0, text: "Already ordered work", status: "pending",
    submittedAt: null, submitFenceAt: null, lastReason: "wake-refused:quota-floor: Claude Fixture has 2 % of its week left" }];
  state.set("quota_floor_alert_v1", { version: 1, accounts: { "claude:fixture": { id: "original-episode", name: "Claude Fixture", status: "held", panes: ["fixture:0"], jobs: ["original-job"], receipts: {} } } });
  let calls = 0;
  const deps = { state, now: () => now, agent: { paneProcessState: async () => ({ running: true }), getContext: async () => ({ tokens: 473000 }),
    isBusy: async () => false, promptTransportState: async () => ({ state: "empty-idle" }) },
    queue: { list: () => jobs, acquireSessionLease: () => ({ release() {} }) },
    resolveTarget: () => ({ dir: root, engine: "claude" }), identityFor: () => ({ path, sessionId: "original-session" }),
    activityFor: () => now - 51 * 60000, recordCompact: () => {},
    compactFor: () => async () => {
      calls++;
      if (refuses) throw Error("fixture refusal before submit");
      appendFileSync(path, JSON.stringify({ type: "system", subtype: "compact_boundary" }) + "\n");
      return { ok: true, compactBoundary: true, sessionId: "original-session" };
    } };
  return { root, path, state, statePath, deps, jobs, calls: () => calls,
    maintenance: () => createContextMaintenance({ ...deps, state: createState(statePath) }) };
}

it("compacts a warm idle pane while its original unsent quota-held job remains queued", async () => {
  const fx = fixture(), before = JSON.stringify(fx.jobs);
  expect(await fx.maintenance().run("fixture", 0)).toMatchObject({ ok: true, compacted: true });
  expect(fx.calls()).toBe(1); expect(JSON.stringify(fx.jobs)).toBe(before);
});

it("keeps the proven episode when a queued retry temporarily clears its current reason", async () => {
  const fx = fixture(); fx.jobs[0].lastReason = null;
  expect((await fx.maintenance().run("fixture", 0)).compacted).toBe(true); expect(fx.calls()).toBe(1);
});

it("accepts only the unsent stage of a floor-held delivering job", async () => {
  const fx = fixture(); fx.jobs[0].status = "delivering";
  expect((await fx.maintenance().run("fixture", 0)).compacted).toBe(true); expect(fx.calls()).toBe(1);
});

it("persists the maximum of two quota-episode attempts across controller reloads", async () => {
  const fx = fixture({ refuses: true });
  await fx.maintenance().run("fixture", 0); await fx.maintenance().run("fixture", 0);
  const third = await fx.maintenance().run("fixture", 0);
  expect(fx.calls()).toBe(2); expect(third.reason).toContain("quota-floor-compact-limit");
  expect(fx.state.get("quota_floor_alert_v1").accounts["claude:fixture"].warmCompactions["fixture:0"].attempts).toHaveLength(2);
});

it("does not reset the budget for a new session, and resets it only for a new quota episode", async () => {
  const fx = fixture({ refuses: true });
  await fx.maintenance().run("fixture", 0); await fx.maintenance().run("fixture", 0);
  fx.deps.identityFor = () => ({ path: fx.path, sessionId: "new-session" });
  expect((await fx.maintenance().run("fixture", 0)).reason).toContain("quota-floor-compact-limit"); expect(fx.calls()).toBe(2);
  const data = fx.state.get("quota_floor_alert_v1"); data.accounts["claude:fixture"].id = "new-proven-episode";
  data.accounts["claude:fixture"].warmCompactions = {}; fx.state.set("quota_floor_alert_v1", data);
  await fx.maintenance().run("fixture", 0); expect(fx.calls()).toBe(3);
});

it.each([
  { status: "submitting" }, { status: "unknown" }, { submittedAt: 123 }, { submitFenceAt: 123 },
  { draftOwned: true }, { metadata: { deliveryOutcome: "unknown" } },
])("does not excuse delivery evidence %j", async evidence => {
  const fx = fixture(); Object.assign(fx.jobs[0], evidence);
  expect((await fx.maintenance().run("fixture", 0)).ok).toBe(false);
  expect(fx.calls()).toBe(0);
});

it("leaves another unclassified pending job and foreign or active input fenced", async () => {
  const queued = fixture(); queued.jobs.push({ id: "another-job", status: "pending" });
  expect((await queued.maintenance().run("fixture", 0)).ok).toBe(false); expect(queued.calls()).toBe(0);
  const draft = fixture(); draft.deps.agent.promptTransportState = async () => ({ state: "foreign-draft" });
  expect((await draft.maintenance().run("fixture", 0)).ok).toBe(false); expect(draft.calls()).toBe(0);
  const active = fixture(); active.deps.agent.isBusy = async () => true;
  expect((await active.maintenance().run("fixture", 0)).ok).toBe(false); expect(active.calls()).toBe(0);
  const background = fixture(); background.deps.coldBeforeDelivery = { background: () => "fixture-active-subagent" };
  expect((await background.maintenance().run("fixture", 0)).reason).toContain("fixture-active-subagent"); expect(background.calls()).toBe(0);
});

it("checks cache warmth again immediately before input", async () => {
  const fx = fixture(); let clock = fx.deps.now(), inputs = 0;
  fx.deps.now = () => clock; fx.deps.agent.sendOnly = async () => { inputs++; };
  fx.deps.compactFor = () => async ({ agent }) => { clock += 10 * 60000; await agent.sendOnly("fixture", "/compact", 0); return { ok: true }; };
  expect((await fx.maintenance().run("fixture", 0)).ok).toBe(false); expect(inputs).toBe(0);
});

it("does not carry the warm exception into cold cache or missing episode evidence", async () => {
  const cold = fixture(); cold.deps.activityFor = () => cold.deps.now() - 61 * 60000;
  expect((await cold.maintenance().run("fixture", 0)).ok).toBe(false); expect(cold.calls()).toBe(0);
  const unknown = fixture(); unknown.state.set("quota_floor_alert_v1", { version: 1, accounts: {} });
  expect((await unknown.maintenance().run("fixture", 0)).ok).toBe(false); expect(unknown.calls()).toBe(0);
});

it("preserves an unknown compact across a new controller and session instead of using the second allowance", async () => {
  const fx = fixture();
  fx.deps.agent.sendOnly = async (_name, _text, _pane, options) => { await options.onSubmitting(); throw Error("lost compact response"); };
  fx.deps.compactFor = () => async ({ agent }) => { await agent.sendOnly("fixture", "/compact", 0); return { ok: true }; };
  await fx.maintenance().run("fixture", 0);
  fx.deps.identityFor = () => ({ path: fx.path, sessionId: "later-session" });
  const blocked = await fx.maintenance().run("fixture", 0);
  expect(blocked.reason).toContain("quota-floor-compact-unknown");
  expect(fx.state.get("quota_floor_alert_v1").accounts["claude:fixture"].warmCompactions["fixture:0"].attempts).toHaveLength(1);
});

it("holds a submitted pending job even through the ordinary before-delivery path", async () => {
  const fx = fixture(); fx.jobs[0].submittedAt = 123;
  const result = await fx.maintenance().run("fixture", 0, { beforeDelivery: true, jobId: fx.jobs[0].id });
  expect(result.ok).toBe(false); expect(fx.calls()).toBe(0);
});

it("preserves a real queued identity across compact and delivers its work once after the existing floor gate opens", async () => {
  const fx = fixture(), queue = createDeliveryQueue({ rootDir: join(fx.root, "queue"), now: fx.deps.now });
  const job = queue.enqueue({ agentName: "fixture", pane: 0, text: "Already ordered work", source: "cli" });
  const input = composerAgent(); let usedPercent = 98, clock = fx.deps.now();
  const broker = createDeliveryBroker({ agent: input.agent, queue, now: () => clock, notify: async () => {},
    quotaFloor: { percent: 3, windowsFor: async () => ({ account: { provider: "claude", name: "Claude Fixture" }, observedAt: clock,
      windows: [{ kind: "week", usedPercent, resetsAt: new Date(clock + 86400000).toISOString() }] }) } });
  await broker.kickTarget("fixture", 0);
  const held = queue.read("fixture", 0, job.id); expect(held.lastReason).toContain("wake-refused:quota-floor:");
  const data = fx.state.get("quota_floor_alert_v1"); data.accounts["claude:fixture"].jobs = [job.id]; fx.state.set("quota_floor_alert_v1", data);
  const maintenance = createContextMaintenance({ ...fx.deps, queue });
  expect((await maintenance.run("fixture", 0)).compacted).toBe(true);
  expect(queue.read("fixture", 0, job.id)).toEqual(held); expect(input.pane.submitted).toEqual([]);
  usedPercent = 0; clock += 61000;
  await broker.kickTarget("fixture", 0); await broker.kickTarget("fixture", 0);
  expect(queue.list("fixture", 0)).toHaveLength(1); expect(queue.read("fixture", 0, job.id).status).toBe("acknowledged");
  expect(input.pane.submitted).toEqual(["Already ordered work"]);
});
