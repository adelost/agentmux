import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQuotaParkFacts } from "../channels/quota-park.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { quotaParkContinuation } from "./quota-park.mjs";
import { composerAgent } from "../test/fixtures/composer-agent.mjs";

function world({ inUse = ["claw:2"], usedPercent = 98 } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-floor-failure-"));
  let now = Date.parse("2026-10-21T01:15:00Z"), failed = false, moved = false, listed = true, contextReady = true;
  const account = { ok: true, provider: "claude", name: "Claude S", profile: { key: "claude:1" },
    inUse, limits: [{ kind: "weekly_all", usedPercent, resetsAt: "2026-10-27T04:00:00Z" }] };
  const profiles = [{ key: "claude:1", provider: "claude", home: join(root, "s") },
    { key: "claude:2", provider: "claude", home: join(root, "a") }];
  const facts = createQuotaParkFacts({ now: () => now, profiles: () => profiles,
    readPanes: async () => moved ? [{ key: "claw:2", engine: "claude", home: profiles[1].home }] : null,
    read: async () => ({ accounts: [failed ? { ...account, ok: false, limits: [], error: "network_error" }
      : { ...account, fetchedAt: new Date(now).toISOString() },
      { ...account, name: "Claude A", profile: profiles[1], inUse: [], limits: [{ ...account.limits[0], usedPercent: 40 }] }]
      .map(({ inUse: panes, ...rest }) => listed ? { ...rest, inUse: panes } : rest) }) });
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => now });
  const { agent, pane } = composerAgent();
  const broker = createDeliveryBroker({ agent, queue, now: () => now, notify: async () => {},
    costAdmission: async () => contextReady ? { ok: true } : { ok: false, held: true, reason: "compact unverified" },
    quotaFloor: { percent: 3, windowsFor: facts } });
  return { facts, queue, broker, pane, fail: () => { failed = true; now += 6 * 60_000; }, later: (ms) => { now += ms; },
    move: () => { moved = true; },
    unlist: () => { listed = false; now += 6 * 60_000; }, holdContext: () => { contextReady = false; },
    readyContext: () => { contextReady = true; now += 6 * 60_000; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("quota floor read failures (component)", () => {
  // lsrc:0 2026-10-21: from 04:23 to 04:30Z one network_error held every Claude pane's automatic work, while another
  // reader saw Claude A at 2 % of its week.
  component("a failed reading of an account last read with room does not hold its panes", {
    given: ["claw:2's account read at 2 % of its week, then its reading fails", async () => {
      const ctx = world({ usedPercent: 2 }); await ctx.facts("claw:2"); ctx.fail();
      ctx.queue.enqueue({ agentName: "claw", pane: 2, text: "synthetic task", source: "cli" }); return ctx;
    }],
    when: ["the broker delivers the automatic prompt", ctx => ctx.broker.kickTarget("claw", 2)],
    then: ["the turn starts, since the last good reading leaves the floor far away", (_result, ctx) => {
      try { expect(ctx.pane.submitted).toEqual(["synthetic task"]); } finally { ctx.cleanup(); }
    }],
  });
  component("a failed reading whose last good one is over 30 minutes old holds the panes", {
    given: ["claw:2's account read at 2 % of its week, then 36 minutes of failed readings", async () => {
      const ctx = world({ usedPercent: 2 }); await ctx.facts("claw:2"); ctx.later(30 * 60_000); ctx.fail();
      ctx.job = ctx.queue.enqueue({ agentName: "claw", pane: 2, text: "synthetic task", source: "cli" }); return ctx;
    }],
    when: ["the broker delivers the automatic prompt", ctx => ctx.broker.kickTarget("claw", 2)],
    then: ["no turn starts until a reading shows room", (_result, ctx) => {
      try {
        expect(ctx.pane.submitted).toEqual([]);
        expect(ctx.queue.read("claw", 2, ctx.job.id)).toMatchObject({ status: "pending", costHold: true });
      } finally { ctx.cleanup(); }
    }],
  });
  // api:0 2026-10-21: a context hold also sets costHold, and a pane on no quota account has no floor to keep.
  component("a context hold on a pane outside every quota account clears once its compact is verified", {
    given: ["claw:2 runs on no quota account, and its prompt waited for an unverified compact", async () => {
      const ctx = world({ inUse: [] }); ctx.holdContext();
      ctx.job = ctx.queue.enqueue({ agentName: "claw", pane: 2, text: "after the compact", source: "cli" });
      await ctx.broker.kickTarget("claw", 2); ctx.readyContext(); return ctx;
    }],
    when: ["the broker retries with the compact verified", ctx => ctx.broker.kickTarget("claw", 2)],
    then: ["the prompt is delivered, since no quota floor applies to it", (_result, ctx) => {
      try { expect(ctx.pane.submitted).toEqual(["after the compact"]); } finally { ctx.cleanup(); }
    }],
  });
  component("a snapshot without its pane listing keeps an observed floor hold", {
    given: ["claw:2 held at Claude S's floor, then the pane listing fails", async () => {
      const ctx = world();
      ctx.job = ctx.queue.enqueue({ agentName: "claw", pane: 2, text: "synthetic task", source: "cli" });
      await ctx.broker.kickTarget("claw", 2); ctx.unlist(); return ctx;
    }],
    when: ["the broker retries without knowing which account the pane runs on", ctx => ctx.broker.kickTarget("claw", 2)],
    then: ["no turn starts and the durable job keeps its hold", (_result, ctx) => {
      try {
        expect(ctx.pane.submitted).toEqual([]);
        expect(ctx.queue.read("claw", 2, ctx.job.id)).toMatchObject({ status: "pending", costHold: true });
      } finally { ctx.cleanup(); }
    }],
  });
  component("a failed source reading cannot hold a pane proved running on an account with room", {
    given: ["the cached source failed but the pane now runs on Claude A with room", async () => {
      const ctx = world(); ctx.fail(); await ctx.facts("claw:2"); ctx.move();
      ctx.queue.enqueue({ agentName: "claw", pane: 2, text: "follow the moved pane", source: "cli" }); return ctx;
    }],
    when: ["the broker rechecks the live account", ctx => ctx.broker.kickTarget("claw", 2)],
    then: ["the prompt follows verified room instead of waiting for cache expiry", (_result, ctx) => {
      try { expect(ctx.pane.submitted).toEqual(["follow the moved pane"]); } finally { ctx.cleanup(); }
    }],
  });
  for (const park of [true, false]) {
    component(`${park ? "a parked continuation" : "an ordinary automatic prompt"} waits through network_error`, {
      given: ["Claude S at 98 %, then its provider reading fails", async () => {
        const ctx = world();
        await ctx.facts("claw:2");
        ctx.job = ctx.queue.enqueue({ agentName: "claw", pane: 2, source: park ? "self-compact" : "cli",
          text: park ? quotaParkContinuation({ window: "week", resetAt: Date.parse("2026-10-27T04:00:00Z") }) : "synthetic task" });
        if (park) await ctx.broker.kickTarget("claw", 2);
        ctx.fail();
        return ctx;
      }],
      when: ["the broker retries with the failed provider response", ctx => ctx.broker.kickTarget("claw", 2)],
      then: ["no turn starts and the durable job keeps its hold", (_result, ctx) => {
        try {
          expect(ctx.pane.submitted).toEqual([]);
          expect(ctx.queue.read("claw", 2, ctx.job.id)).toMatchObject({ status: "pending", costHold: true });
        } finally { ctx.cleanup(); }
      }],
    });
  }
});

// lsrc:0 for Mattias 2026-10-21 (quota brief case 8): Codex A's credits fell from 56 881 to 56 765 overnight while its
// 5 h window was spent; until 1.25.298 a failed reading of a spent window let automatic turns through.
function codexWorld() {
  const root = mkdtempSync(join(tmpdir(), "amux-floor-codex-"));
  let now = Date.parse("2026-10-21T03:50:00Z"), failed = false;
  const account = { ok: true, provider: "codex", name: "Codex A", profile: { key: "codex:1", id: "1" }, inUse: ["api:6"],
    limits: [{ limitId: "codex", windows: [{ windowMinutes: 300, usedPercent: 100, resetsAt: "2026-10-21T08:16:16Z" },
      { windowMinutes: 10080, usedPercent: 77, resetsAt: "2026-10-27T14:22:00Z" }] }] };
  const facts = createQuotaParkFacts({ now: () => now, profiles: () => [], readPanes: async () => null,
    read: async () => ({ accounts: [failed ? { ...account, ok: false, limits: [], error: "network_error" }
      : { ...account, fetchedAt: new Date(now).toISOString() }] }) });
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => now });
  const { agent, pane } = composerAgent({ dialect: "codex" });
  const broker = createDeliveryBroker({ agent, queue, now: () => now, notify: async () => {},
    quotaFloor: { percent: 3, windowsFor: facts, creditsAllowed: false } });
  return { facts, queue, broker, pane, fail: () => { failed = true; now += 6 * 60_000; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("a Codex pane at a spent 5 h window (component)", () => {
  component("starts no automatic turn while credits are held, also when its reading fails, and his own message goes through", {
    given: ["api:6 on Codex A with its 5 h window spent until 08:16Z, then a failed reading", async () => {
      const ctx = codexWorld(); await ctx.facts("api:6"); ctx.fail();
      ctx.job = ctx.queue.enqueue({ agentName: "api", pane: 6, text: "[from lsrc:0] synthetic brief", source: "cli" });
      ctx.queue.enqueue({ agentName: "api", pane: 6, text: "Hur går det?", source: "discord" });
      return ctx;
    }],
    when: ["the broker serves api:6 twice", async ctx => { await ctx.broker.kickTarget("api", 6); await ctx.broker.kickTarget("api", 6); }],
    then: ["only his message is typed; the brief waits for the reset", (_result, ctx) => {
      try {
        expect(ctx.pane.submitted).toEqual(["Hur går det?"]);
        expect(ctx.queue.read("api", 6, ctx.job.id)).toMatchObject({ status: "pending", costHold: true });
      } finally { ctx.cleanup(); }
    }],
  });
});
