import { feature, component, expect } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createQuotaParkFacts } from "../channels/quota-park.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { quotaParkContinuation } from "./quota-park.mjs";
import { composerAgent } from "../test/fixtures/composer-agent.mjs";

function world({ inUse = ["claw:2"] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-floor-failure-"));
  let now = Date.parse("2026-10-21T01:15:00Z"), failed = false, moved = false, listed = true, contextReady = true;
  const account = { ok: true, provider: "claude", name: "Claude S", profile: { key: "claude:1" },
    inUse, limits: [{ kind: "weekly_all", usedPercent: 98, resetsAt: "2026-10-27T04:00:00Z" }] };
  const profiles = [{ key: "claude:1", provider: "claude", home: join(root, "s") },
    { key: "claude:2", provider: "claude", home: join(root, "a") }];
  const facts = createQuotaParkFacts({ now: () => now, profiles: () => profiles,
    readPanes: async () => moved ? [{ key: "claw:2", engine: "claude", home: profiles[1].home }] : null,
    read: async () => ({ accounts: [failed ? { ...account, ok: false, limits: [], error: "network_error" } : account,
      { ...account, name: "Claude A", profile: profiles[1], inUse: [], limits: [{ ...account.limits[0], usedPercent: 40 }] }]
      .map(({ inUse: panes, ...rest }) => listed ? { ...rest, inUse: panes } : rest) }) });
  const queue = createDeliveryQueue({ rootDir: join(root, "queue"), now: () => now });
  const { agent, pane } = composerAgent();
  const broker = createDeliveryBroker({ agent, queue, now: () => now, notify: async () => {},
    costAdmission: async () => contextReady ? { ok: true } : { ok: false, held: true, reason: "compact unverified" },
    quotaFloor: { percent: 3, windowsFor: facts } });
  return { facts, queue, broker, pane, fail: () => { failed = true; now += 6 * 60_000; }, move: () => { moved = true; },
    unlist: () => { listed = false; now += 6 * 60_000; }, holdContext: () => { contextReady = false; },
    readyContext: () => { contextReady = true; now += 6 * 60_000; },
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("quota floor read failures (component)", () => {
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
