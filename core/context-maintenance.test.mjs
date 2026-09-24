import { component, expect, feature } from "bdd-vitest";
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextMaintenanceAttempt, createContextMaintenance } from "./context-maintenance.mjs";
import { wakeDeliveryTarget } from "./delivery-wake.mjs";
import { captureJsonlAppendCursor } from "./jsonl-append-cursor.mjs";

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
  component("a later Codex response_item user turn expires a saved maintenance receipt", {
    given: ["a compact receipt followed by actual Codex user work", () => {
      const ctx = fixture();
      const path = ctx.identityFor().path;
      const cursor = captureJsonlAppendCursor("context-maintenance-v1", [path]);
      ctx.state.set("context_maintenance_by_pane_v1", {
        "claw:2": { sessionId: "one", cursor, status: "VERIFIED" },
      });
      ctx.append({ type: "compacted" });
      ctx.append({ type: "response_item", payload: { type: "message", role: "user",
        content: [{ type: "input_text", text: "new work" }],
        internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } } });
      return ctx;
    }],
    when: ["reading the old receipt", ctx => contextMaintenanceAttempt(ctx.state, "claw", 2, { sessionId: "one" })],
    then: ["the old receipt cannot authorize another model change", (receipt, ctx) => {
      try { expect(receipt).toBeNull(); } finally { ctx.cleanup(); }
    }],
  });
  component("a cold first message enters an exact session with no work after compact", {
    given: ["the compacted Claude journal has only local command output and bridge metadata", () => {
      const ctx = fixture();
      ctx.agent.getContext = async () => ({ tokens: null });
      ctx.activityFor = () => null;
      ctx.journalFor = () => null;
      ctx.append({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 150_000 } } });
      ctx.append({ type: "system", subtype: "compact_boundary", sessionId: "one", timestamp: "2026-09-20T13:39:06.009Z" });
      ctx.append({ type: "user", isCompactSummary: true, message: { content: "summary" } });
      ctx.append({ type: "user", message: { content: "<local-command-stdout>Compacted</local-command-stdout>" } });
      ctx.append({ type: "attachment", timestamp: "2026-09-23T20:02:48.865Z" });
      ctx.append({ type: "pr-link", timestamp: "2026-09-23T20:02:48.865Z" });
      return ctx;
    }],
    when: ["admitting the first delivery through the existing guard", ctx => createContextMaintenance(ctx).beforeWork({ agentName: "claw", pane: 2, id: "first" })],
    then: ["the first message is admitted without a provider compact", (result, ctx) => {
      try { expect(result.ok).toBe(true); expect(ctx.calls).toHaveLength(0); } finally { ctx.cleanup(); }
    }],
  });
  for (const [name, entries] of [
    ["a missing compact boundary", [{ type: "attachment" }]],
    ["a malformed compact boundary", [{ type: "system", subtype: "compact_boundary", sessionId: "one", timestamp: "invalid" }]],
    ["another session's compact boundary", [{ type: "system", subtype: "compact_boundary", sessionId: "other", timestamp: "2026-09-20T13:39:06.009Z" }]],
    ["unknown work after compact", [
      { type: "system", subtype: "compact_boundary", sessionId: "one", timestamp: "2026-09-20T13:39:06.009Z" },
      { type: "user", message: { content: "new work" } },
    ]],
    ["an assistant turn after compact", [
      { type: "system", subtype: "compact_boundary", sessionId: "one", timestamp: "2026-09-20T13:39:06.009Z" },
      { type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 200_000 } } },
    ]],
  ]) {
    component(`${name} still blocks cold delivery when usage is unknown`, {
      given: ["the exact journal has no trustworthy empty epoch", () => {
        const ctx = fixture();
        ctx.agent.getContext = async () => ({ tokens: null });
        ctx.activityFor = () => null;
        ctx.journalFor = () => null;
        entries.forEach(ctx.append);
        return ctx;
      }],
      when: ["admitting the first delivery", ctx => createContextMaintenance(ctx).beforeWork({ agentName: "claw", pane: 2, id: "first" })],
      then: ["the guard holds and spends no provider compact", (result, ctx) => {
        try { expect(result.reason).toContain("context-cost:unknown-evidence"); expect(ctx.calls).toHaveLength(0); }
        finally { ctx.cleanup(); }
      }],
    });
  }
  component("transport admits the proven empty pane and retains unknown work as pending", {
    given: ["two exact idle sessions with unknown usage and different post-compact histories", () => {
      const empty = fixture(), used = fixture();
      for (const ctx of [empty, used]) {
        ctx.agent.getContext = async () => ({ tokens: null });
        ctx.activityFor = () => null;
        ctx.journalFor = () => null;
        ctx.append({ type: "system", subtype: "compact_boundary", sessionId: "one", timestamp: "2026-09-20T13:39:06.009Z" });
      }
      used.append({ type: "assistant", message: { content: [{ type: "text", text: "prior work" }] } });
      return { empty, used };
    }],
    when: ["routing one prompt to each session through delivery wake admission", async ({ empty, used }) => {
      const route = ctx => wakeDeliveryTarget({
        agent: ctx.agent,
        job: { id: "first", kind: "prompt", agentName: "claw", pane: 2, status: "pending" },
        costAdmission: job => createContextMaintenance(ctx).beforeWork(job),
        queue: { update: (job, patch) => ({ ...job, ...patch }) },
        now: () => 100_000_000, retryMs: () => 1_000,
        queueEvent: () => {}, notifyBlocked: async job => job,
      });
      return { accepted: await route(empty), retained: await route(used) };
    }],
    then: ["only the empty pane proceeds, with no provider compact", (result, { empty, used }) => {
      try {
        expect(result.accepted.proceed).toBe(true);
        expect(result.retained).toMatchObject({ proceed: false, job: { status: "pending", lastReason: "wake-refused:context-cost:unknown-evidence" } });
        expect(empty.calls).toHaveLength(0);
        expect(used.calls).toHaveLength(0);
      } finally { empty.cleanup(); used.cleanup(); }
    }],
  });
  component("a cold 88k pane compacts before its first queued prompt", {
    given: ["an exact idle session with 88k tokens after 24 hours", () => {
      const ctx = fixture();
      ctx.agent.getContext = async () => ({ tokens: 88_000 });
      return ctx;
    }],
    when: ["admitting the first cold delivery", ctx => ctx.maintenance.beforeWork({ agentName: "claw", pane: 2, id: "first" })],
    then: ["one compact happens before the prompt is admitted", (result, ctx) => {
      try { expect(result.ok).toBe(true); expect(ctx.calls).toEqual(["compact"]); } finally { ctx.cleanup(); }
    }],
  });
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
