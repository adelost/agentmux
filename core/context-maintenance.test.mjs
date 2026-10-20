import { component, expect, feature } from "bdd-vitest";
import { appendFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { contextMaintenanceAttempt, createContextMaintenance } from "./context-maintenance.mjs";
import { deliveryHead, wakeDeliveryTarget } from "./delivery-wake.mjs";
import { captureJsonlAppendCursor } from "./jsonl-append-cursor.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createSelfCompactStore } from "./self-compact.mjs";
import { verifiedClaudeCompact } from "./verified-compact.mjs";
import { composerAgent } from "../test/fixtures/composer-agent.mjs";

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
  component("an explicit switch compact still runs for a small context, once per work generation", {
    given: ["a small idle session with an explicit compact requirement", () => {
      const ctx = fixture();
      ctx.agent.getContext = async () => ({ tokens: 1_000 });
      return ctx;
    }],
    when: ["requesting it twice, then requesting it after genuinely new work", async ctx => {
      const m = createContextMaintenance(ctx);
      const first = await m.run("claw", 2, { required: true });
      const same = await m.run("claw", 2, { required: true });
      ctx.append({ type: "user", message: { content: "new work after the verified compact" } });
      const next = await m.run("claw", 2, { required: true });
      return { first, same, next };
    }],
    then: ["the existing native fence allows only one call for each actual generation", ({ first, same, next }, ctx) => {
      expect(first.compacted).toBe(true);
      expect(same.cell).toBe("receipt-exists");
      expect(next.compacted).toBe(true);
      expect(ctx.calls).toHaveLength(2);
    }], cleanup: ctx => ctx.cleanup(),
  });
  component("an explicit compact requirement does not override unread context or a failed attempt", {
    when: ["requesting maintenance for unknown usage and a refused prior call", async () => {
      const unknown = fixture(), failed = fixture({ fail: true });
      unknown.agent.getContext = async () => ({ tokens: null });
      try {
        const a = await createContextMaintenance(unknown).run("claw", 2, { required: true });
        const m = createContextMaintenance(failed);
        await m.run("claw", 2, { required: true });
        const b = await m.run("claw", 2, { required: true });
        return { a, b, calls: [unknown.calls.length, failed.calls.length] };
      } finally { unknown.cleanup(); failed.cleanup(); }
    }],
    then: ["both hold without a second paid attempt", ({ a, b, calls }) => {
      expect(a.ok).toBe(false); expect(b.ok).toBe(false); expect(calls).toEqual([0, 1]);
    }],
  });
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
  component("a Codex prompt the provider refused leaves the maintenance receipt in force", {
    given: ["a compact receipt followed by a prompt no model ran on", () => {
      const ctx = fixture();
      const cursor = captureJsonlAppendCursor("context-maintenance-v1", [ctx.identityFor().path]);
      ctx.state.set("context_maintenance_by_pane_v1", { "lsrc:4": { sessionId: "one", cursor, status: "VERIFIED" } });
      ctx.append({ type: "compacted" });
      ctx.append({ type: "event_msg", payload: { type: "user_message", message: "Hej" } });
      ctx.append({ type: "event_msg", payload: { type: "task_complete", last_agent_message: null } });
      return ctx;
    }],
    when: ["reading the receipt before and after an answered prompt", ctx => {
      const refused = contextMaintenanceAttempt(ctx.state, "lsrc", 4, { sessionId: "one" });
      ctx.append({ type: "event_msg", payload: { type: "user_message", message: "Hej" } });
      ctx.append({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 9 } } } });
      return { refused, answered: contextMaintenanceAttempt(ctx.state, "lsrc", 4, { sessionId: "one" }) };
    }],
    then: ["only work a model ran on expires it", ({ refused, answered }, ctx) => {
      try {
        expect(refused?.status).toBe("VERIFIED");
        expect(answered).toBeNull();
      } finally { ctx.cleanup(); }
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
  component("a cold message enters an empty epoch whose bookkeeping and compact time are known", {
    given: ["lsrc:1 on 2026-09-24: frame-link after compact and an activity time from the compact output", () => {
      const ctx = fixture();
      ctx.agent.getContext = async () => ({ tokens: null });
      ctx.activityFor = () => 100_000_000 - 5 * 86_400_000;   // the compact output, five days before now()
      ctx.journalFor = () => null;
      ctx.append({ type: "system", subtype: "compact_boundary", sessionId: "one", timestamp: "2026-09-19T02:06:47.912Z" });
      ctx.append({ type: "user", isCompactSummary: true, message: { content: "summary" } });
      ctx.append({ type: "user", message: { content: "<local-command-stdout>Compacted</local-command-stdout>" } });
      ctx.append({ type: "frame-link", timestamp: "2026-09-19T02:06:48.200Z" });
      ctx.append({ type: "some-future-bookkeeping" });
      return ctx;
    }],
    when: ["admitting the first delivery", ctx => createContextMaintenance(ctx).beforeWork({ agentName: "claw", pane: 2, id: "first" })],
    then: ["the message is admitted without a provider compact", (result, ctx) => {
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
  // Mattias 2026-09-26: a held delivery locks the orchestrated pane ("då kommer ju
  // panelen låsa sig"), so the owner's message passes unknown evidence. Automatic
  // work does not: unknown context cannot authorize paid work (claw:3 2026-10-13).
  component("transport admits the proven empty pane, and the unknown pane only for its owner", {
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
    when: ["routing an automatic prompt to each session, and the owner's message to the unknown one", async ({ empty, used }) => {
      const route = (ctx, job = {}) => wakeDeliveryTarget({
        agent: ctx.agent,
        job: { id: "first", kind: "prompt", agentName: "claw", pane: 2, status: "pending", source: "cli", text: "Fortsätt", ...job },
        costAdmission: job => createContextMaintenance(ctx).beforeWork(job),
        queue: { update: (job, patch) => ({ ...job, ...patch }) },
        now: () => 100_000_000, retryMs: () => 1_000,
        queueEvent: () => {}, notifyBlocked: async job => job,
      });
      return { accepted: await route(empty), unknown: await route(used), owner: await route(used, { id: "mine", source: "discord" }) };
    }],
    then: ["the empty epoch and the owner proceed, automatic work on unknown context waits, and nothing is compacted", (result, { empty, used }) => {
      try {
        expect(result.accepted.proceed).toBe(true);
        expect(result.unknown).toMatchObject({ proceed: false, job: { costHold: true, lastReason: "wake-refused:held-for-evidence:context-cost:unknown-evidence" } });
        expect(result.owner.proceed).toBe(true);
        expect(empty.calls).toHaveLength(0);
        expect(used.calls).toHaveLength(0);
      } finally { empty.cleanup(); used.cleanup(); }
    }],
  });
  component("a pane idle past the one-hour cache compacts before its next prompt", {
    given: ["an exact idle session with 473k tokens, last reply 61 minutes ago", () => {
      const ctx = fixture();
      ctx.agent.getContext = async () => ({ tokens: 473_000 });
      ctx.activityFor = () => 100_000_000 - 61 * 60_000;
      return ctx;
    }],
    when: ["admitting the delivery", ctx => createContextMaintenance(ctx).beforeWork({ agentName: "claw", pane: 2, id: "first" })],
    then: ["one compact happens before the prompt is admitted", (result, ctx) => {
      try { expect(result.ok).toBe(true); expect(ctx.calls).toEqual(["compact"]); } finally { ctx.cleanup(); }
    }],
  });
  component("a cold 250k pane compacts before its first queued prompt", {
    given: ["an exact idle session with 250k tokens after 24 hours", () => {
      const ctx = fixture();
      ctx.agent.getContext = async () => ({ tokens: 250_000 });
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
      ctx.agent.getContext = async () => ({ tokens: 250_000 });
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
  // lsrc:2, 2026-09-27: the weekly limit refused /compact at 20:29 and a bridge
  // restart warned again at 22:06. These are the rows Claude 2.1.283 journaled.
  const quotaRefusedCompactRows = [
    { type: "user", message: { role: "user", content: "/compact" } },
    { type: "user", isMeta: true, message: { role: "user", content: "<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>" } },
    { type: "user", message: { role: "user", content: "<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>" } },
    { type: "system", subtype: "local_command", commandRun: { command: "compact", args: "" }, commandOutcome: { kind: "failed" },
      content: "<local-command-stderr>Error during compaction: You've hit your weekly limit · resets Sep 30, 9am (Europe/Stockholm)</local-command-stderr>" },
  ];
  const refusedByQuota = () => {
    const ctx = fixture();
    ctx.compactFor = () => async () => {
      ctx.calls.push("compact");
      quotaRefusedCompactRows.forEach(ctx.append);
      return { ok: false, reason: "provider-usage-limited" };
    };
    return ctx;
  };
  component("a quota-refused /compact stays one attempt, also after a bridge restart", {
    given: ["Claude journals the refused command exactly as on lsrc:2", refusedByQuota],
    when: ["the idle controller tries once, then a restarted bridge checks the same pane", async ctx => {
      await createContextMaintenance(ctx).run("claw", 2);
      const restarted = createContextMaintenance(ctx);
      return { canAttempt: restarted.canAttempt("claw", 2, "one"), retry: await restarted.run("claw", 2) };
    }],
    then: ["no new warning is allowed and no second provider call happens", (result, ctx) => {
      try {
        expect(result.canAttempt).toBe(false);
        expect(result.retry.ok).toBe(false);
        expect(ctx.calls).toEqual(["compact"]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a real prompt after a refused /compact allows one new attempt", {
    given: ["the refused compact, then a new user prompt in the same session", async () => {
      const ctx = refusedByQuota();
      await createContextMaintenance(ctx).run("claw", 2);
      ctx.append({ type: "user", message: { role: "user", content: "Hej, fortsätt med rundan" } });
      return ctx;
    }],
    when: ["a restarted bridge checks the pane", ctx => createContextMaintenance(ctx).canAttempt("claw", 2, "one")],
    then: ["the pane may be compacted again", (canAttempt, ctx) => {
      try { expect(canAttempt).toBe(true); } finally { ctx.cleanup(); }
    }],
  });
  component("a refused attempt tells the caller it was attempted and why", {
    given: ["Claude refuses the compact for quota", refusedByQuota],
    when: ["the idle controller tries once", ctx => createContextMaintenance(ctx).run("claw", 2)],
    then: ["the result names the attempt and keeps the provider's reason", (result, ctx) => {
      try {
        expect(result).toMatchObject({ ok: false, attempted: true, reason: "context-cost:provider-usage-limited" });
      } finally { ctx.cleanup(); }
    }],
  });
  // claw:2 and ai:1 on 2026-10-20: their idle compacts met the session limit at 11:06Z and nothing tried again after
  // its reset at 11:10Z, while their caches lived to 11:14Z and 11:15Z. At 11:23Z they read 606k and 190k cold.
  component("a compact refused by Claude's session limit may run again once that limit resets", {
    given: ["claw:2's compact refused at 11:06:34Z until 1:10pm Stockholm", () => {
      const ctx = fixture();
      ctx.clock = Date.parse("2026-10-20T11:06:34Z");
      ctx.now = () => ctx.clock;
      ctx.compactFor = () => async () => {
        ctx.calls.push("compact");
        return { ok: false, reason: "provider-usage-limited",
          detail: "Error during compaction: You’ve hit your session limit · resets 1:10pm (Europe/Stockholm)" };
      };
      return ctx;
    }],
    when: ["the idle controller tries, then asks again before and after 11:10Z", async ctx => {
      const maintenance = createContextMaintenance(ctx);
      const refused = await maintenance.run("claw", 2);
      ctx.clock = Date.parse("2026-10-20T11:09:00Z");
      const before = maintenance.canAttempt("claw", 2, "one");
      ctx.clock = Date.parse("2026-10-20T11:10:20Z");
      return { retryAt: refused.retryAt, before, after: maintenance.canAttempt("claw", 2, "one") };
    }],
    then: ["the attempt names the reset, and the fence opens at it", ({ retryAt, before, after }, ctx) => {
      try {
        expect(retryAt).toBe(Date.parse("2026-10-20T11:10:00Z"));
        expect([before, after]).toEqual([false, true]);
      } finally { ctx.cleanup(); }
    }],
  });
  // The same stop through the real compact: the screen showed the limit before the journal was read (11:06:53Z).
  component("claw:2's compact refused on screen at 11:06Z may run again once the limit resets", {
    given: ["claw:2's screen and journal as the session limit refused its /compact", () => {
      const ctx = fixture();
      ctx.clock = Date.parse("2026-10-20T11:06:51.635Z");
      ctx.now = () => ctx.clock;
      const path = ctx.identityFor().path;
      ctx.agent.capturePromptEchoCursor = async () => captureJsonlAppendCursor("claude-prompt-events-v1", [path]);
      ctx.agent.captureScreen = async () =>
        "❯ /compact\n  ⎿  Error during compaction: You've hit your session limit · resets 1:10pm (Europe/Stockholm)\n";
      ctx.compactFor = () => args => verifiedClaudeCompact({ ...args, now: ctx.now, sleep: async ms => { ctx.clock += ms; },
        sendSlash: async () => {
          ctx.append({ type: "system", subtype: "local_command", timestamp: "2026-10-20T11:06:53.063Z",
            content: "<local-command-stderr>Error during compaction: You've hit your session limit · resets 1:10pm (Europe/Stockholm)</local-command-stderr>",
            commandRun: { command: "compact", args: "" }, commandOutcome: { kind: "failed" } });
          return { delivered: true, via: "command-receipt" };
        } });
      return ctx;
    }],
    when: ["the idle controller tries, then asks again before and after 11:10Z", async ctx => {
      const maintenance = createContextMaintenance(ctx);
      const refused = await maintenance.run("claw", 2);
      ctx.clock = Date.parse("2026-10-20T11:09:00Z");
      const before = maintenance.canAttempt("claw", 2, "one");
      ctx.clock = Date.parse("2026-10-20T11:10:20Z");
      return { refused, before, after: maintenance.canAttempt("claw", 2, "one") };
    }],
    then: ["the refusal names the 11:10Z reset, and the fence opens at it", ({ refused, before, after }, ctx) => {
      try {
        expect(refused).toMatchObject({ attempted: true, reason: "context-cost:provider-usage-limited",
          retryAt: Date.parse("2026-10-20T11:10:00Z") });
        expect([before, after]).toEqual([false, true]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("pending messages behind a cold head cannot deadlock its compact", {
    given: ["a delivering head followed by another pending message", () => fixture({ jobs: [{ id: "head", status: "delivering" }, { id: "later", status: "pending" }] })],
    when: ["admitting the first work item", ctx => ctx.maintenance.beforeWork({ agentName: "claw", pane: 2, id: "head" })],
    then: ["one compact releases the head", (result, ctx) => { try { expect(result.ok).toBe(true); expect(ctx.calls).toHaveLength(1); } finally { ctx.cleanup(); } }],
  });
});

// lsrc, 2026-10-02: lsrc:3's compact held the whole session lease from 09:01
// to 09:04:51, so lsrc:2's warned compact was refused and ran cold 42 minutes
// later. While an engine compacts, only its own pane stays fenced.
function sharedSession(ctx) {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-cost-lease-"));
  const bridge = createDeliveryQueue({ rootDir }), other = createDeliveryQueue({ rootDir });
  const seen = {};
  ctx.compactFor = () => async ({ onCommandAccepted }) => {
    await onCommandAccepted?.();
    const sibling = other.acquireSessionLease("claw", 3);
    seen.sibling = Boolean(sibling);
    sibling?.release();
    seen.samePane = Boolean(other.acquireSessionLease("claw", 2));
    ctx.append({ type: "system", subtype: "compact_boundary" });
    return { ok: true, compactBoundary: true, sessionId: "one" };
  };
  return { ...ctx, queue: bridge, other, seen, cleanup: () => { ctx.cleanup(); rmSync(rootDir, { recursive: true, force: true }); } };
}

feature("a compact waiting on its engine fences only its own pane", () => {
  component("a sibling pane is served while an idle compact runs", {
    given: ["claw:2 compacts while claw:3 has work", () => sharedSession(fixture())],
    when: ["the idle controller compacts claw:2", ctx => createContextMaintenance(ctx).run("claw", 2)],
    then: ["claw:3 gets the session and claw:2 stays fenced", (result, ctx) => {
      try {
        expect(result.compacted).toBe(true);
        expect(ctx.seen).toEqual({ sibling: true, samePane: false });
        const after = ctx.other.acquireSessionLease("claw");
        expect(after).toBeTruthy();
        after.release();
      } finally { ctx.cleanup(); }
    }],
  });
  component("a cold compact before delivery hands the session back to the broker", {
    given: ["the broker holds claw:2's lease for a queued prompt", () => {
      const ctx = sharedSession(fixture());
      ctx.agent.getContext = async () => ({ tokens: 250_000 });
      ctx.brokerLease = ctx.queue.acquireSessionLease("claw", 2);
      return ctx;
    }],
    when: ["admitting the prompt", ctx => createContextMaintenance(ctx).beforeWork({ agentName: "claw", pane: 2, id: "first" }, { lease: ctx.brokerLease })],
    then: ["siblings were served during the compact and the broker writes with the session", (result, ctx) => {
      try {
        expect(result.ok).toBe(true);
        expect(ctx.seen).toEqual({ sibling: true, samePane: false });
        expect(ctx.brokerLease.holdsSession()).toBe(true);
        expect(ctx.other.acquireSessionLease("claw", 3)).toBeNull();
      } finally { ctx.brokerLease.release(); ctx.cleanup(); }
    }],
  });
});

feature("a held Claude paste never buys or fakes a compact", () => {
  // skyvw:0, 2026-10-09 23:09Z: the cold compact typed /compact into a composer held by "Pasting…",
  // waited ten minutes for a receipt that could not come, and the pane kept 889 855 tokens.
  component("a cold compact never starts while Claude is still pasting", {
    given: ["a large idle Claude session whose composer a paste holds", () => {
      const ctx = fixture();
      ctx.agent.promptTransportState = async () => ({ state: "pasting", busy: false, dialect: "claude" });
      return ctx;
    }],
    when: ["the first automatic and the first Discord delivery after the night are admitted", async ctx => ({
      automatic: await createContextMaintenance(ctx).beforeWork({ agentName: "skyvw", pane: 0, id: "first", source: "cli" }),
      owner: await createContextMaintenance(ctx).beforeWork({ agentName: "skyvw", pane: 0, id: "mine", source: "discord", text: "Hur går det?" }),
    })],
    then: ["no compact is attempted, the automatic work waits and the owner's message is delivered", ({ automatic, owner }, ctx) => {
      try {
        expect(ctx.calls).toHaveLength(0);
        expect(automatic).toMatchObject({ ok: false, cell: "held-for-compact", reason: "held-for-compact:context-cost:not-idle:pasting" });
        expect(owner).toMatchObject({ ok: true, cell: "delivered-uncompacted", reason: "context-cost:not-idle:pasting" });
      } finally { ctx.cleanup(); }
    }],
  });
  component("a compact without a receipt stays failed until Claude journals its boundary", {
    given: ["the FAILED compact-command-unverified record skyvw:0 kept overnight", () => {
      const ctx = fixture();
      const cursor = captureJsonlAppendCursor("context-maintenance-v1", [ctx.identityFor().path]);
      ctx.state.set("context_maintenance_by_pane_v1", {
        "skyvw:0": { sessionId: "one", cursor, status: "FAILED", reason: "compact-command-unverified" },
      });
      return ctx;
    }],
    when: ["reading it before and after a real compact boundary", ctx => {
      const before = contextMaintenanceAttempt(ctx.state, "skyvw", 0, { sessionId: "one" });
      ctx.append({ type: "system", subtype: "compact_boundary" });
      return { before: before?.status, after: contextMaintenanceAttempt(ctx.state, "skyvw", 0, { sessionId: "one" })?.status };
    }],
    then: ["only the journaled boundary makes it verified", (result, ctx) => {
      try { expect(result).toEqual({ before: "FAILED", after: "VERIFIED" }); } finally { ctx.cleanup(); }
    }],
  });
});

// skyvw:4 2026-10-13: a recovery prompt and Wingman follow-ups reached a 409k
// context 94 minutes cold. Mattias 2026-10-13: compact before resuming. Automatic
// work waits for a verified compact; the owner's own message still goes through.
feature("automatic work waits on a cold context whose compact did not verify", () => {
  const afterRefusedCompact = async () => {
    const ctx = fixture({ fail: true });
    await ctx.maintenance.run("claw", 2, { cold: true, leaseHeld: true });
    return ctx;
  };
  const admit = (ctx, job) => createContextMaintenance(ctx).beforeWork({ agentName: "claw", pane: 2, text: "Fortsätt", ...job });
  component("a recovery prompt, a timer follow-up and another pane's message all wait, with no second attempt", {
    given: ["a cold 473k pane whose compact quota refused", afterRefusedCompact],
    when: ["three automatic messages arrive through a restarted controller", async ctx => [
      await admit(ctx, { id: "recovery", source: "cli" }),
      await admit(ctx, { id: "wingman", source: "cli" }),
      await admit(ctx, { id: "relay", source: "discord", metadata: { sender: "claw:3" } })]],
    then: ["each is held with the failed attempt as its reason", (results, ctx) => {
      try {
        expect(results.map(r => [r.ok, r.cell])).toEqual([[false, "held-for-compact"], [false, "held-for-compact"], [false, "held-for-compact"]]);
        expect(results[0].reason).toBe("held-for-compact:context-cost:failed-attempt:provider-usage-limited");
        expect(ctx.calls).toEqual(["compact"]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("the owner's Discord or voice message is delivered uncompacted", {
    given: ["the same refused compact", afterRefusedCompact],
    when: ["Mattias writes and speaks to the pane", async ctx => [
      await admit(ctx, { id: "typed", source: "discord" }), await admit(ctx, { id: "spoken", source: "voice-pwa" })]],
    then: ["both go through and nothing is paid again", (results, ctx) => {
      try {
        expect(results.map(r => r.cell)).toEqual(["delivered-uncompacted", "delivered-uncompacted"]);
        expect(ctx.calls).toEqual(["compact"]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("an owner's message queued behind a held automatic prompt does not release it", {
    given: ["the refused compact, a recovery prompt at the head and Mattias's \"Stopp\" behind it", async () => {
      const ctx = await afterRefusedCompact();
      ctx.jobs.push({ id: "recovery", source: "cli", status: "pending", text: "Fortsätt" },
        { id: "mine", source: "discord", status: "pending", text: "Stopp" });
      return ctx;
    }],
    when: ["the head is admitted", ctx => admit(ctx, { id: "recovery", source: "cli" })],
    then: ["the head still waits for its own evidence", (result, ctx) => {
      try { expect(result).toMatchObject({ ok: false, held: true, cell: "held-for-compact" }); expect(ctx.calls).toEqual(["compact"]); }
      finally { ctx.cleanup(); }
    }],
  });
  component("the broker serves the owner's message past an untyped job held for its cost", {
    when: ["choosing the next job for several queues", () => {
      const held = { id: "recovery", source: "cli", status: "pending", costHold: true, text: "Fortsätt" };
      const later = { id: "wingman", source: "cli", status: "pending", text: "Fortsätt" };
      const mine = { id: "mine", source: "discord", status: "pending", text: "Stopp" };
      return [
        deliveryHead([held, later, mine]),
        deliveryHead([held, later]),
        deliveryHead([{ ...held, draftOwned: true }, mine]),
        deliveryHead([{ ...held, status: "submitted" }, mine]),
        deliveryHead([{ ...held, costHold: null }, mine]),
      ].map(job => job.id);
    }],
    then: ["only the owner's message passes, and only an untyped held job; the held job stays queued", ids =>
      expect(ids).toEqual(["mine", "recovery", "recovery", "recovery", "recovery"])],
  });
  component("a compact boundary that appears later releases the waiting work", {
    given: ["the refused compact, then a boundary journaled for the same session", async () => {
      const ctx = await afterRefusedCompact();
      ctx.append({ type: "system", subtype: "compact_boundary" });
      return ctx;
    }],
    when: ["the held recovery prompt is retried", ctx => admit(ctx, { id: "recovery", source: "cli" })],
    then: ["it is delivered on the verified receipt", (result, ctx) => {
      try { expect(result).toMatchObject({ ok: true, cell: "receipt-exists" }); expect(ctx.calls).toEqual(["compact"]); }
      finally { ctx.cleanup(); }
    }],
  });
  component("a small or recently used context is never held", {
    given: ["a 60k pane quiet for 61 minutes and a 473k pane quiet for 5", () => {
      const small = fixture({ fail: true }), warm = fixture({ fail: true });
      small.agent.getContext = async () => ({ tokens: 60_000 });
      small.activityFor = () => 100_000_000 - 61 * 60_000;
      warm.activityFor = () => 100_000_000 - 5 * 60_000;
      return { small, warm };
    }],
    when: ["an automatic message arrives at each", async ({ small, warm }) => [
      await admit(small, { id: "a", source: "cli" }), await admit(warm, { id: "b", source: "cli" })]],
    then: ["both are delivered without a compact", (results, { small, warm }) => {
      try {
        expect(results.map(r => [r.ok, r.cell])).toEqual([[true, "within-policy"], [true, "within-policy"]]);
        expect([...small.calls, ...warm.calls]).toEqual([]);
      } finally { small.cleanup(); warm.cleanup(); }
    }],
  });
  component("a stopped pane is started for its owner's message but not for automatic work", {
    given: ["a stopped pane and a launch recorder", () => {
      const launches = [];
      const agent = { paneProcessState: async () => ({ running: launches.length > 0 }),
        ensureReady: async (name, pane, launch) => { launches.push(launch); } };
      return { agent, launches };
    }],
    when: ["a timer prompt and a Discord message each wake it", async ({ agent, launches }) => {
      const wake = job => wakeDeliveryTarget({ agent, job: { kind: "prompt", agentName: "skyvw", pane: 4, status: "pending", text: "Fortsätt", ...job },
        wakeGate: async () => ({ ok: true }), queue: { update: (j, patch) => ({ ...j, ...patch }) }, now: () => 0, retryMs: () => 1_000,
        queueEvent: () => {}, notifyBlocked: async j => j });
      const seen = [];
      for (const job of [{ id: "wingman", source: "cli" }, { id: "mine", source: "discord" }]) {
        await wake(job);
        seen.push(launches.splice(0)[0]);
      }
      return seen;
    }],
    then: ["only the owner's own wake may open a context whose compact is unverified", launches =>
      expect(launches).toEqual([null, { work: "HUMAN" }])],
  });
  component("a wake the launch holds for its compact marks the job as a cost hold", {
    given: ["a stopped pane whose start is held", () => ({ paneProcessState: async () => ({ running: false }),
      ensureReady: async () => { throw Object.assign(new Error("Codex resume held: compact-tried"), { costHold: true }); } })],
    when: ["a recovery prompt wakes it", agent => wakeDeliveryTarget({ agent,
      job: { id: "recovery", kind: "prompt", agentName: "skyvw", pane: 4, status: "pending", source: "cli", text: "Fortsätt" },
      wakeGate: async () => ({ ok: true }), queue: { update: (j, patch) => ({ ...j, ...patch }) }, now: () => 0, retryMs: () => 1_000,
      queueEvent: () => {}, notifyBlocked: async j => j })],
    then: ["it stays pending with its reason, passable only by the owner's message", result =>
      expect(result).toMatchObject({ proceed: false, job: { status: "pending", costHold: true, lastReason: "wake-refused:Codex resume held: compact-tried" } })],
  });
});

// skyvw:0 2026-10-11: builders never rest 50 minutes, so a pause compact runs
// one quiet minute after the turn, through the same admission as any compact.
feature("a pause compact goes through the live admission", () => {
  const turnEndedSecondsAgo = (ctx, seconds) => { ctx.activityFor = () => ctx.now() - seconds * 1000; };
  const lastWrite = ctx => ctx.state.get("context_maintenance_by_pane_v1", {})["lsrc:2"];

  component("the 50-minute rule leaves a builder at 473k alone 90 seconds after its turn", {
    given: ["lsrc:2 at 473k, its turn ended 90 s ago", () => { const ctx = fixture(); turnEndedSecondsAgo(ctx, 90); ctx.maintenance = createContextMaintenance(ctx); return ctx; }],
    when: ["running warm maintenance without a pause budget", ctx => ctx.maintenance.run("lsrc", 2)],
    then: ["nothing is compacted", (result, ctx) => {
      try { expect(result.cell).toBe("within-policy"); expect(ctx.calls).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
  component("a pause budget compacts the same builder", {
    given: ["lsrc:2 at 473k, its turn ended 90 s ago", () => { const ctx = fixture(); turnEndedSecondsAgo(ctx, 90); ctx.maintenance = createContextMaintenance(ctx); return ctx; }],
    when: ["running with the 400k builder budget", ctx => ctx.maintenance.run("lsrc", 2, { pauseTokens: 400_000 })],
    then: ["one compact is sent and its time is kept for the spacing rule", (result, ctx) => {
      try {
        expect(result.compacted).toBe(true);
        expect(ctx.calls).toEqual(["compact"]);
        expect(lastWrite(ctx)).toMatchObject({ status: "VERIFIED", at: ctx.now() });
      } finally { ctx.cleanup(); }
    }],
  });
  component("a dry run checks everything and sends nothing", {
    given: ["lsrc:2 at 473k, its turn ended 90 s ago", () => { const ctx = fixture(); turnEndedSecondsAgo(ctx, 90); ctx.maintenance = createContextMaintenance(ctx); return ctx; }],
    when: ["running dry with the builder budget", ctx => ctx.maintenance.run("lsrc", 2, { pauseTokens: 400_000, dry: true })],
    then: ["it reports a would-be compact, sends nothing and writes no attempt", (result, ctx) => {
      try {
        expect(result).toMatchObject({ ok: true, dry: true, cell: "compact-once", tokens: 473_000 });
        expect(ctx.calls).toEqual([]);
        expect(lastWrite(ctx)).toBeUndefined();
      } finally { ctx.cleanup(); }
    }],
  });
  component("a delivery on its way holds the pause compact", {
    given: ["a queued prompt for lsrc:2", () => {
      const ctx = fixture({ jobs: [{ id: "next-step", status: "pending" }] });
      turnEndedSecondsAgo(ctx, 90); ctx.maintenance = createContextMaintenance(ctx); return ctx;
    }],
    when: ["running with the builder budget", ctx => ctx.maintenance.run("lsrc", 2, { pauseTokens: 400_000 })],
    then: ["the prompt goes first", (result, ctx) => {
      try { expect(result.reason).toBe("context-cost:delivery-pending"); expect(ctx.calls).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
  component("text in the composer holds the pause compact", {
    given: ["Mattias is typing in lsrc:2", () => {
      const ctx = fixture(); turnEndedSecondsAgo(ctx, 90);
      ctx.agent.promptTransportState = async () => ({ state: "drafted" });
      ctx.maintenance = createContextMaintenance(ctx); return ctx;
    }],
    when: ["running with the builder budget", ctx => ctx.maintenance.run("lsrc", 2, { pauseTokens: 400_000 })],
    then: ["his draft is left alone", (result, ctx) => {
      try { expect(result.reason).toBe("context-cost:not-idle:drafted"); expect(ctx.calls).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
});

// skyvw:0 2026-10-11: lsrc:4 (370k) and lsrc:5 (310k) got new work at 05:49Z
// after about 50 idle minutes and started on a cold Codex cache.
feature("a pane idle past its cache's life is compacted before a delivery", () => {
  const MIN = 60_000;
  function coldRule(mode, { background = null } = {}) {
    const lines = [];
    const limits = { claude: { idleMs: 50 * MIN, tokens: 80_000 }, codex: { idleMs: 25 * MIN, tokens: 150_000 } };
    return { lines, mode: () => mode, limits: engine => limits[engine], background: () => background, record: line => lines.push(line) };
  }
  function pane({ engine = "claude", tokens = 473_000, idleMinutes, rule = null }) {
    const ctx = fixture();
    ctx.activityFor = () => ctx.now() - idleMinutes * MIN;
    ctx.agent.getContext = async () => ({ tokens });
    ctx.resolveTarget = () => ({ dir: "/lsrc/.agents/4", engine });
    ctx.coldBeforeDelivery = rule;
    ctx.maintenance = createContextMaintenance(ctx);
    return ctx;
  }
  const deliver = ctx => ctx.maintenance.run("lsrc", 4, { cold: true });

  component("the 60-minute cold rule lets a pane idle 55 minutes through uncompacted", {
    given: ["a Claude pane at 473k, idle 55 minutes, no early rule", () => pane({ idleMinutes: 55 })],
    when: ["a delivery arrives", deliver],
    then: ["nothing is compacted", (result, ctx) => {
      try { expect(result.cell).toBe("within-policy"); expect(ctx.calls).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
  component("with the rule on, a Claude pane idle 55 minutes is compacted first", {
    given: ["the same pane with the rule on", () => pane({ idleMinutes: 55, rule: coldRule("on") })],
    when: ["a delivery arrives", deliver],
    then: ["one compact, logged", (result, ctx) => {
      try {
        expect(result.compacted).toBe(true);
        expect(ctx.calls).toEqual(["compact"]);
        // The 2026-10-17 recovery incident requires an ending after the intent.
        expect(ctx.coldBeforeDelivery.lines).toMatchObject([
          { pane: "lsrc:4", cell: "before-delivery", outcome: "compacting", limit: 80_000 },
          { pane: "lsrc:4", cell: "before-delivery", outcome: "compacted" },
        ]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a Claude pane idle 45 minutes still reads a warm cache", {
    given: ["the rule on, idle 45 minutes", () => pane({ idleMinutes: 45, rule: coldRule("on") })],
    when: ["a delivery arrives", deliver],
    then: ["nothing is compacted or logged", (result, ctx) => {
      try { expect(result.cell).toBe("within-policy"); expect(ctx.calls).toEqual([]); expect(ctx.coldBeforeDelivery.lines).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
  component("lsrc:4 at 370k after 50 minutes is logged by the dry run, and delivered as before", {
    given: ["Codex lsrc:4 with the rule dry", () => pane({ engine: "codex", tokens: 370_000, idleMinutes: 50, rule: coldRule("dry") })],
    when: ["lsrc:0's new task arrives", deliver],
    then: ["no compact, one would-compact line against 150k", (result, ctx) => {
      try {
        expect(result.cell).toBe("within-policy");
        expect(ctx.calls).toEqual([]);
        expect(ctx.coldBeforeDelivery.lines).toMatchObject([{ outcome: "would-compact", limit: 150_000, quietSec: 3000 }]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a Codex pane under 150k is not worth a compact", {
    given: ["Codex at 120k, idle 50 minutes, rule on", () => pane({ engine: "codex", tokens: 120_000, idleMinutes: 50, rule: coldRule("on") })],
    when: ["a delivery arrives", deliver],
    then: ["nothing is compacted or logged", (result, ctx) => {
      try { expect(result.cell).toBe("within-policy"); expect(ctx.calls).toEqual([]); expect(ctx.coldBeforeDelivery.lines).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
  component("an active subagent holds the compact and the work is delivered", {
    given: ["a Claude pane idle 55 minutes whose subagent wrote 40 s ago", () =>
      pane({ idleMinutes: 55, rule: coldRule("on", { background: "a subagent or background job wrote 40s ago" }) })],
    when: ["a delivery arrives", deliver],
    then: ["no compact, logged as held", (result, ctx) => {
      try {
        expect(result.cell).toBe("within-policy");
        expect(ctx.calls).toEqual([]);
        expect(ctx.coldBeforeDelivery.lines).toMatchObject([{ outcome: "held", detail: "a subagent or background job wrote 40s ago" }]);
      } finally { ctx.cleanup(); }
    }],
  });
  component("a failing check never stops the delivery", {
    given: ["a Claude pane idle 55 minutes whose background check throws", () => {
      const rule = coldRule("on");
      rule.background = () => { throw new Error("proc unreadable"); };
      return pane({ idleMinutes: 55, rule });
    }],
    when: ["a delivery arrives", deliver],
    then: ["the 60-minute rule decides and the work goes through", (result, ctx) => {
      try { expect(result.cell).toBe("within-policy"); expect(ctx.calls).toEqual([]); } finally { ctx.cleanup(); }
    }],
  });
  component("an open question holds the compact", {
    given: ["a Claude pane idle 55 minutes with a permission prompt", () => {
      const ctx = pane({ idleMinutes: 55, rule: coldRule("on") });
      ctx.agent.promptTransportState = async () => ({ state: "permission" });
      ctx.maintenance = createContextMaintenance(ctx);
      return ctx;
    }],
    when: ["a delivery arrives", deliver],
    then: ["the work is delivered uncompacted, logged as held", (result, ctx) => {
      try {
        expect(result.cell).toBe("within-policy");
        expect(ctx.calls).toEqual([]);
        expect(ctx.coldBeforeDelivery.lines).toMatchObject([{ outcome: "held", detail: "not-idle" }]);
      } finally { ctx.cleanup(); }
    }],
  });
});

feature("a self-request before the next delivery", () => {
  component("the wind-down warning lands before its own turn-end compact", {
    given: ["a warm 120k pane, wind-down self-request and its warning about to land", () => {
      const ctx = fixture();
      ctx.agent.getContext = async () => ({ tokens: 120_000 });
      ctx.activityFor = () => ctx.now() - 5_000;
      const requests = createSelfCompactStore({ dir: join(ctx.identityFor().path, "..", "requests"), now: ctx.now });
      requests.request({ agent: "claw", pane: 2, tokens: 120_000, origin: "quota-wind-down" });
      return { ...ctx, requests };
    }],
    when: ["admitting that warning", ctx => createContextMaintenance({ ...ctx, selfRequests: ctx.requests })
      .beforeWork({ agentName: "claw", pane: 2, id: "warning", source: "quota-wind-down" })],
    then: ["the warning cannot consume its own pending compact and invalidate its receipt", (result, ctx) => {
      try { expect(result.ok).toBe(true); expect(ctx.calls).toEqual([]); expect(ctx.requests.read("claw", 2)?.origin).toBe("quota-wind-down"); }
      finally { ctx.cleanup(); }
    }],
  });
  component("a pane that asked is compacted with its focus before a waiting prompt lands", {
    given: ["claw:2 at 120k, its turn ended 5 s ago, a self-request and a delivery waiting", () => {
      const ctx = fixture();
      ctx.agent.getContext = async () => ({ tokens: 120_000 });
      ctx.activityFor = () => ctx.now() - 5_000;
      const dir = mkdtempSync(join(tmpdir(), "amux-self-compact-"));
      const requests = createSelfCompactStore({ dir, now: ctx.now });
      requests.request({ agent: "claw", pane: 2, tokens: 120_000, focus: "behåll G4-siffrorna" });
      const commands = [], notices = [];
      ctx.compactFor = () => async ({ command }) => {
        commands.push(command ?? "/compact");
        ctx.append({ type: "system", subtype: "compact_boundary" });
        return { ok: true, compactBoundary: true, sessionId: "one" };
      };
      return { ...ctx, requests, commands, notices, dir };
    }],
    when: ["admitting the delivery", ctx => createContextMaintenance({ ...ctx, selfRequests: ctx.requests,
      notify: async (agent, pane, text) => ctx.notices.push(text) }).beforeWork({ agentName: "claw", pane: 2, id: "next" })],
    then: ["one focused compact first, the request ended, the prompt admitted", async (result, ctx) => {
      try {
        expect(result.ok).toBe(true);
        expect(ctx.commands).toEqual(["/compact behåll G4-siffrorna"]);
        expect(ctx.requests.list()).toEqual([]);
        await Promise.resolve();
        expect(ctx.notices).toEqual(["Self-compact **claw:2** at the end of its turn (120000 tokens), focus: behåll G4-siffrorna."]);
      } finally { ctx.cleanup(); rmSync(ctx.dir, { recursive: true, force: true }); }
    }],
  });
  // A park's compact is due before the stop; a job's result after the reset would land on a cold context anyway.
  component("a quota park is compacted before the waiting prompt while a job still writes", {
    given: ["claw:2 parked at 120k with a job that wrote 38 s ago and a delivery waiting", () => {
      const ctx = fixture();
      ctx.agent.getContext = async () => ({ tokens: 120_000 });
      ctx.activityFor = () => ctx.now() - 5_000;
      ctx.coldBeforeDelivery = { mode: () => "on", limits: () => ({ idleMs: 50 * 60_000, tokens: 80_000 }),
        background: () => "a subagent or background job wrote 38s ago", record: () => {} };
      const dir = mkdtempSync(join(tmpdir(), "amux-self-compact-"));
      const requests = createSelfCompactStore({ dir, now: ctx.now });
      requests.request({ agent: "claw", pane: 2, tokens: 120_000, origin: "quota-park" });
      return { ...ctx, requests, dir };
    }],
    when: ["admitting the delivery", ctx => createContextMaintenance({ ...ctx, selfRequests: ctx.requests })
      .beforeWork({ agentName: "claw", pane: 2, id: "next" })],
    then: ["one compact first, then the prompt", (result, ctx) => {
      try {
        expect(result.ok).toBe(true);
        expect(ctx.calls).toEqual(["compact"]);
      } finally { ctx.cleanup(); rmSync(ctx.dir, { recursive: true, force: true }); }
    }],
  });
});

// skyvw:3, 2026-10-20: the idle compact wrote its intent at 12:23:35.3Z and typed /compact; a bridge restart 0.8 s later
// ended the bridge before its Enter. The intent stayed ATTEMPTING, the command stayed in the composer, and every
// delivery from 12:25:30Z was refused for 50 minutes until a person pressed Enter.
feature("a compact its writer never finished", () => {
  const STOPPED_BRIDGE_PID = 4_000_001;
  const NEXT_DELIVERY = "[from lsrc:2] row 322";
  /** WHAT: skyvw:3's cut compact: its intent, and /compact unsent in a Codex composer. WHY: The 12:23Z failure shape. */
  const cutCompact = ({ record, alive }) => {
    const ctx = fixture();
    const { agent: paneAgent, pane } = composerAgent({ dialect: "codex", composer: "/compact" });
    ctx.state.set("context_maintenance_by_pane_v1", { "skyvw:3": { sessionId: "one", status: "ATTEMPTING",
      cursor: captureJsonlAppendCursor("context-maintenance-v1", [ctx.identityFor().path]), cell: "compact-once", beforeTokens: 199_327,
      at: ctx.now() - 115_000, ...record } });
    Object.assign(ctx.agent, { getContext: async () => ({ tokens: 1_000 }), promptTransportState: paneAgent.promptTransportState,
      captureScreen: paneAgent.captureScreen, clearInputLine: paneAgent.clearInputLine, sendEscape: paneAgent.sendEscape });
    return { ...ctx, resolveTarget: () => ({ dir: "/pane", engine: "codex" }), writerAlive: () => alive, pane, paneAgent };
  };
  const deliverNext = async ctx => {
    const admitted = await createContextMaintenance(ctx).beforeWork({ agentName: "skyvw", pane: 3, id: "next" });
    let refused = null;
    try { await ctx.paneAgent.sendOnly("skyvw", NEXT_DELIVERY, 3); } catch (error) { refused = error.message; }
    return { admitted, refused, intent: ctx.state.get("context_maintenance_by_pane_v1")["skyvw:3"] };
  };

  component("is withdrawn before the next delivery, which then lands", {
    when: ["the next delivery comes for a stopped bridge's intent and for a 50-minute-old one without a writer", async () =>
      Promise.all([{ record: { pid: STOPPED_BRIDGE_PID }, alive: false }, { record: { at: 100_000_000 - 50 * 60_000 }, alive: true }]
        .map(async shape => { const ctx = cutCompact(shape); try { return { ...await deliverNext(ctx), pane: ctx.pane }; } finally { ctx.cleanup(); } }))],
    then: ["the /compact is erased unsent, the delivery is submitted, and the policy may decide again", rows => {
      for (const { admitted, refused, intent, pane } of rows) {
        expect(refused).toBeNull();
        expect(pane.submitted).toEqual([NEXT_DELIVERY]);
        expect(admitted.ok).toBe(true);
        expect(intent).toMatchObject({ status: "NOT_SENT", reason: "abandoned-before-submit" });
      }
    }],
  });

  component("is left alone while its writer still runs, which may still press Enter", {
    given: ["the intent of a live writer and its /compact in the composer", () => cutCompact({ record: { pid: STOPPED_BRIDGE_PID }, alive: true })],
    when: ["the next delivery comes", deliverNext],
    then: ["no key touches the composer and the intent stays open", ({ intent }, ctx) => {
      try {
        expect(ctx.pane.keys).toEqual([]);
        expect(ctx.pane.composer).toBe("/compact");
        expect(intent.status).toBe("ATTEMPTING");
      } finally { ctx.cleanup(); }
    }],
  });
});
