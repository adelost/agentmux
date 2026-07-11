import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createInboundReconciler } from "./inbound-reconciler.mjs";

function setup(initial = {}) {
  const data = structuredClone(initial);
  const state = {
    get: vi.fn((key, fallback) => Object.hasOwn(data, key) ? data[key] : fallback),
    set: vi.fn((key, value) => { data[key] = value; }),
  };
  const delivered = [];
  const onMessage = vi.fn(async (msg) => { delivered.push(msg.id); });
  return { data, state, delivered, onMessage };
}

function msg(id, { bot = false, channelId = "ch" } = {}) {
  return { id, channelId, isBot: bot, text: id };
}

feature("Discord inbound reconciliation", () => {
  unit("a missed human correction is replayed before the cursor advances past later bot output", {
    given: ["cursor before a human correction and bot reply", () => {
      const ctx = setup({ last_inbound_ch: "100" });
      ctx.channel = {
        fetchMissed: vi.fn(async () => ({
          messages: [msg("110")],
          newestId: "120",
        })),
      };
      ctx.reconciler = createInboundReconciler(ctx);
      return ctx;
    }],
    when: ["the channel is reconciled", (ctx) => ctx.reconciler.reconcile(ctx.channel, "ch")],
    then: ["the correction is delivered and only then is the scan cursor advanced", (_, ctx) => {
      expect(ctx.delivered).toEqual(["110"]);
      expect(ctx.data.last_inbound_ch).toBe("120");
    }],
  });

  unit("live delivery and REST replay of the same message are deduplicated", {
    given: ["one live message followed by a scan containing it", () => {
      const ctx = setup({ last_inbound_ch: "100" });
      ctx.channel = { fetchMissed: vi.fn(async () => ({ messages: [msg("110")], newestId: "110" })) };
      ctx.reconciler = createInboundReconciler(ctx);
      return ctx;
    }],
    when: ["both paths run", async (ctx) => {
      await ctx.reconciler.enqueue(msg("110"));
      await ctx.reconciler.reconcile(ctx.channel, "ch");
    }],
    then: ["the agent receives one prompt", (_, ctx) => expect(ctx.delivered).toEqual(["110"])],
  });

  unit("a failed replay does not advance the cursor or poison the retry", {
    given: ["handler fails once", () => {
      const ctx = setup({ last_inbound_ch: "100" });
      ctx.onMessage.mockRejectedValueOnce(new Error("bridge dying"));
      ctx.channel = { fetchMissed: vi.fn(async () => ({ messages: [msg("110")], newestId: "120" })) };
      ctx.reconciler = createInboundReconciler(ctx);
      return ctx;
    }],
    when: ["first scan fails and second scan retries", async (ctx) => {
      await expect(ctx.reconciler.reconcile(ctx.channel, "ch")).rejects.toThrow("bridge dying");
      expect(ctx.data.last_inbound_ch).toBe("100");
      await ctx.reconciler.reconcile(ctx.channel, "ch");
    }],
    then: ["the retry succeeds and advances", (_, ctx) => {
      expect(ctx.onMessage).toHaveBeenCalledTimes(2);
      expect(ctx.data.last_inbound_ch).toBe("120");
    }],
  });

  unit("bot gateway events never enter the agent queue", {
    given: ["a bot message", () => {
      const ctx = setup();
      ctx.reconciler = createInboundReconciler(ctx);
      return ctx;
    }],
    when: ["it arrives live", (ctx) => ctx.reconciler.enqueue(msg("200", { bot: true }))],
    then: ["it is ignored", (_, ctx) => expect(ctx.onMessage).not.toHaveBeenCalled()],
  });
});
