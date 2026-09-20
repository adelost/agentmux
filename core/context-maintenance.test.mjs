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
    agent: { getContext: async () => ({ tokens: 473_000 }), isBusy: async () => false,
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
  return { ...deps, calls, append, maintenance: createContextMaintenance(deps),
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("warm and cold compaction share a durable one-attempt fence", () => {
  component("no repeated paid compact without new work, including bridge restart", {
    given: ["an idle large context with a mocked provider", () => fixture()],
    when: ["compacting and checking again through a new controller", async ctx => {
      await ctx.maintenance.run("claw", 2);
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
