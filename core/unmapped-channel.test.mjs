import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature, unit } from "bdd-vitest";
import { createDiscordInboundStore } from "./discord-inbound-store.mjs";
import { createInboundReconciler } from "./inbound-reconciler.mjs";
import { createUnmappedChannelAnswer, sendUnmappedChannelNotice } from "./unmapped-channel.mjs";

const synced = { "ai-7-kimi": "1551820617467035729", "ai-8-qwen": "1551820619639824395" };

/** A bridge whose runtime map lacks #ai-8-qwen, wired with the hook bot.mjs installs. */
function bridgeWithoutQwenMapping() {
  const rootDir = mkdtempSync(join(tmpdir(), "amux-unmapped-channel-"));
  const replies = [];
  const delivered = [];
  const logged = [];
  const channel = {};
  const reply = (msg) => async (payload, post) => { replies.push({ messageId: msg.id, payload, post }); };
  const inbound = createInboundReconciler({
    store: createDiscordInboundStore({ rootDir }),
    state: null,
    resolveTarget: () => null,
    onMessage: async (msg) => { delivered.push(msg.id); return { delivered: true }; },
    onUnroutable: createUnmappedChannelAnswer({ syncedChannels: () => synced, log: (line) => logged.push(line) }),
  });
  const message = (id, channelId, extra = {}) => {
    const msg = { id, channelId, text: "hej", authorId: "human", isBot: false, createdTimestamp: Date.now(), attachments: [], ...extra };
    msg.reply = reply(msg);
    return msg;
  };
  return { rootDir, inbound, channel, replies, delivered, logged, message };
}

feature("a message in an unmapped amux channel is answered instead of dropped", () => {
  component("Mattias says hej in #ai-8-qwen while the runtime map lacks it", {
    given: ["a bridge whose channel map lacks the synced #ai-8-qwen", bridgeWithoutQwenMapping],
    when: ["the Gateway delivers the message", async (fx) => ({
      result: await fx.inbound.enqueue(fx.message("1559140232253669447", "1551820619639824395"), fx.channel),
    })],
    then: ["one visible notice names the channel and says no agent got it", ({ result }, fx) => {
      expect(result).toMatchObject({ ignored: "unmapped", notified: true });
      expect(fx.delivered).toEqual([]);
      expect(fx.replies).toHaveLength(1);
      expect(fx.replies[0].messageId).toBe("1559140232253669447");
      expect(fx.replies[0].payload.content).toContain("#ai-8-qwen");
      expect(fx.replies[0].payload.content).toContain("Ingen panel läser #ai-8-qwen");
      expect(fx.replies[0].post).toEqual({ kind: "notice" });
      expect(fx.logged).toEqual(["[inbound] #ai-8-qwen (1551820619639824395) has no pane mapping; answered with a notice"]);
    }],
    cleanup: (fx) => rmSync(fx.rootDir, { recursive: true, force: true }),
  });

  component("other guild channels and bot posts stay silent", {
    given: ["the same bridge", bridgeWithoutQwenMapping],
    when: ["a human writes in a non-amux channel and a bot posts in #ai-8-qwen", async (fx) => ({
      other: await fx.inbound.enqueue(fx.message("1", "999"), fx.channel),
      bot: await fx.inbound.enqueue(fx.message("2", "1551820619639824395", { isBot: true }), fx.channel),
    })],
    then: ["neither is answered", ({ other, bot }, fx) => {
      expect(other).toMatchObject({ ignored: "unmapped", notified: false });
      expect(bot).toEqual({ ignored: "bot" });
      expect(fx.replies).toEqual([]);
    }],
    cleanup: (fx) => rmSync(fx.rootDir, { recursive: true, force: true }),
  });
});

feature("the notice is stable per message", () => {
  unit("a repeated Gateway event carries the same nonce", {
    given: ["one message in #ai-8-qwen", () => {
      const payloads = [];
      const msg = { id: "1559140232253669447", channelId: "1551820619639824395", reply: async (payload) => { payloads.push(payload); } };
      return { msg, payloads };
    }],
    when: ["the notice is sent twice", async ({ msg, payloads }) => {
      await sendUnmappedChannelNotice({}, msg, "ai-8-qwen");
      await sendUnmappedChannelNotice({}, msg, "ai-8-qwen");
      return payloads;
    }],
    then: ["Discord can drop the second by its enforced nonce", (payloads) => {
      expect(payloads[0].nonce).toBe(payloads[1].nonce);
      expect(payloads[0].enforceNonce).toBe(true);
    }],
  });
});
