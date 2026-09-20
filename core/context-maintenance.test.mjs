import { component, expect, feature } from "bdd-vitest";
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContextMaintenance } from "./context-maintenance.mjs";

function fixture({ fail = false, jobs = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-cost-test-")), path = join(root, "session.jsonl");
  writeFileSync(path, "");
  const data = {}, calls = [];
  const append = e => appendFileSync(path, JSON.stringify(e) + "\n");
  const state = { get: (k, fallback) => data[k] ?? fallback, set: (k, v) => { data[k] = v; } };
  const deps = { state, now: () => 100_000_000,
    agent: { paneProcessState: async () => ({ running: true }), getContext: async () => ({ tokens: 473_000 }), isBusy: async () => false,
      promptTransportState: async () => ({ state: "empty-idle" }) },
    queue: { list: () => jobs, acquireSessionLease: () => ({ release() {} }) },
    resolveTarget: () => ({ dir: root, engine: "claude" }),
    identityFor: () => ({ path, sessionId: "one" }), activityFor: () => 1,
    compactFor: () => async () => {
      calls.push("compact");
      if (fail) return { ok: false, reason: "provider-usage-limited" };
      append({ type: "system", subtype: "compact_boundary" });
      return { ok: true, compactBoundary: true, sessionId: "one" };
    },
  };
  return { ...deps, calls, jobs, append, maintenance: createContextMaintenance(deps),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("warm and cold compaction share a durable one-attempt fence", () => {
  component("old terminal history cannot wake a stopped pane for automatic compact", {
    given: ["a stopped process with apparently idle historical context", () => {
      const ctx = fixture();
      ctx.agent.paneProcessState = async () => ({ running: false });
      return ctx;
    }],
    when: ["the idle controller checks it", ctx => createContextMaintenance(ctx).run("claw", 2)],
    then: ["the process stays stopped and no model call occurs", (result, ctx) => {
      try { expect(result.skipped).toBe("not-running"); expect(ctx.calls).toHaveLength(0); } finally { ctx.cleanup(); }
    }],
  });
  component("a queued message arriving before paste aborts maintenance without consuming its model attempt", {
    given: ["new delivery arrives between the idle check and compact submit", () => {
      const ctx = fixture();
      ctx.agent.sendOnly = async () => { ctx.calls.push("sent"); };
      ctx.compactFor = () => async ({ agent }) => {
        ctx.jobs.push({ id: "new-work", status: "pending" });
        await agent.sendOnly("claw", "/compact", 2, {});
        return { ok: true };
      };
      return ctx;
    }],
    when: ["starting idle maintenance", ctx => createContextMaintenance(ctx).run("claw", 2)],
    then: ["nothing is submitted and a later safe attempt remains possible", (result, ctx) => {
      try { expect(result.ok).toBe(false); expect(ctx.calls).toHaveLength(0); expect(createContextMaintenance(ctx).canAttempt("claw", 2, "one")).toBe(true); }
      finally { ctx.cleanup(); }
    }],
  });
  component("a recent provider usage receipt prevents a large active turn from being mistaken for a cold wake", {
    given: ["a giant turn hides its opening user message but recent actual usage is readable", () => {
      const ctx = fixture();
      ctx.activityFor = () => null;
      ctx.journalFor = () => ({ source: "claude-jsonl", observedAt: new Date(99_999_000).toISOString() });
      return ctx;
    }],
    when: ["admitting work through the cost guard", ctx => createContextMaintenance(ctx).beforeWork({ agentName: "claw", pane: 2, id: "next" })],
    then: ["no compact or false hold interrupts the active session", (result, ctx) => {
      try { expect(result.ok).toBe(true); expect(ctx.calls).toHaveLength(0); } finally { ctx.cleanup(); }
    }],
  });
  component("no repeated paid compact without new work, including bridge restart", {
    given: ["an idle large context with a mocked provider", () => fixture()],
    when: ["compacting and checking again through a new controller", async ctx => {
      await ctx.maintenance.run("claw", 2);
      ctx.agent.getContext = async () => ({ tokens: 120_000 });
      await createContextMaintenance(ctx).run("claw", 2, { cold: true, leaseHeld: true });
    }],
    then: ["only one provider call occurred", (_, ctx) => { try { expect(ctx.calls).toEqual(["compact"]); } finally { ctx.cleanup(); } }],
  });
  component("failed compact blocks retries until a real compact receipt appears", {
    given: ["quota refuses compact", () => fixture({ fail: true })],
    when: ["retrying the cold wake", async ctx => {
      await ctx.maintenance.run("claw", 2, { cold: true, leaseHeld: true });
      const blocked = await ctx.maintenance.run("claw", 2, { cold: true, leaseHeld: true });
      ctx.append({ type: "system", subtype: "compact_boundary" });
      return { blocked, recovered: await ctx.maintenance.run("claw", 2, { cold: true, leaseHeld: true }) };
    }],
    then: ["retries spend no quota and later receipt releases work", (result, ctx) => {
      try { expect(result.blocked.ok).toBe(false); expect(result.recovered.ok).toBe(true); expect(ctx.calls).toHaveLength(1); }
      finally { ctx.cleanup(); }
    }],
  });
  component("pending messages behind a cold head cannot deadlock its compact", {
    given: ["a delivering head followed by another pending message", () => fixture({ jobs: [{ id: "head", status: "delivering" }, { id: "later", status: "pending" }] })],
    when: ["admitting the first work item", ctx => ctx.maintenance.beforeWork({ agentName: "claw", pane: 2, id: "head" })],
    then: ["one compact releases the head", (result, ctx) => { try { expect(result.ok).toBe(true); expect(ctx.calls).toHaveLength(1); } finally { ctx.cleanup(); } }],
  });
});
