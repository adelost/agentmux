// Discord channel adapter. Thin wrapper around discord.js Client.
// All normalization logic lives in normalize.mjs.

import { Client, GatewayIntentBits, Events } from "discord.js";
import { normalizeDiscordMessage } from "./normalize.mjs";
import { collectDiscordHistory, findDiscordNonce } from "./discord-history.mjs";

/**
 * @param {{ token: string, onSent?: (channelId: string) => void }} config
 *   onSent fires after any successful outbound message (both from normalized
 *   msg.reply/send and from direct send(channelId, text)). The bridge uses
 *   this to stamp channel_last_mirror_ts in state, enabling the catch-up
 *   notice for stale channels.
 * @returns {import('./channel.mjs').Channel}
 * WHAT: Wraps discord.js events and REST operations in the channel contract.
 * WHY: Keeps transport objects out of delivery and reconciliation logic.
 */
export function createDiscordChannel({ token, onSent }) {
  let handler = null;
  const stamp = (channelId) => { if (onSent) { try { onSent(channelId); } catch {} } };
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  return {
    name: "discord",

    onMessage(callback) {
      handler = callback;
    },

    start() {
      client.on(Events.MessageCreate, (msg) => {
        if (handler) {
          Promise.resolve(handler(normalizeDiscordMessage(msg, { onSent }))).catch((err) =>
            console.warn(`Discord MessageCreate handler failed: ${err.message}`));
        }
      });
      return new Promise((resolve) => {
        client.once(Events.ClientReady, (c) => {
          resolve({ user: c.user.tag });
        });
        client.login(token);
      });
    },

    async send(channelId, text) {
      const ch = await client.channels.fetch(channelId);
      if (!ch) {
        // Deleted/unbound channel must FAIL, not no-op: a silent drop here
        // looks like "agent never replied" with zero diagnostics. Callers
        // (watcher/handlers) already catch and log send errors.
        throw new Error(`channel ${channelId} not found (deleted or not visible to the bot)`);
      }
      await ch.send(text);
      stamp(channelId);
    },

    /** WHAT: Fetches every Discord message after one durable cursor. WHY: Gateway reconnects do not replay history and a one-page scan can skip busy outage windows. */
    async fetchMissed(channelId, afterId, {
      limit = 100,
      maxAgeMs = 7 * 24 * 60 * 60 * 1000,
    } = {}) {
      const ch = await client.channels.fetch(channelId);
      if (!ch?.messages) return { messages: [], newestId: afterId || null };
      const history = await collectDiscordHistory({
        fetchPage: (options) => ch.messages.fetch(options), afterId, limit, maxAgeMs,
      });
      const messages = history.messages.map((m) => normalizeDiscordMessage(m, { onSent }));
      const { newestId } = history;
      return { messages, newestId };
    },

    /** Fetch one historical human message for legacy delivery recovery. */
    async fetchMessage(channelId, messageId) {
      const ch = await client.channels.fetch(channelId);
      if (!ch?.messages) return null;
      const msg = await ch.messages.fetch(messageId);
      if (!msg || msg.author.bot) return null;
      return normalizeDiscordMessage(msg, { onSent });
    },

    /** WHAT: Replies to one persisted Discord message. WHY: Restarted transcript work needs reply semantics without retaining a live Gateway object. */
    async replyTo(channelId, messageId, content) {
      const ch = await client.channels.fetch(channelId);
      if (!ch?.messages) throw new Error(`channel ${channelId} cannot fetch messages`);
      const msg = await ch.messages.fetch(messageId);
      if (!msg) throw new Error(`message ${channelId}:${messageId} not found`);
      const result = await msg.reply(content);
      stamp(channelId);
      return result;
    },

    /** WHAT: Finds one prior transcript request by its stable nonce. WHY: Reconciles a Discord send whose acknowledgement was lost before retrying it. */
    async findMessageByNonce(channelId, nonce, afterId) {
      const ch = await client.channels.fetch(channelId);
      if (!ch?.messages) throw new Error(`channel ${channelId} cannot reconcile messages`);
      return findDiscordNonce({
        fetchPage: (options) => ch.messages.fetch(options),
        nonce,
        afterId,
        botUserId: client.user?.id || null,
      });
    },

    // Fire-and-forget. Discord shows the indicator for ~10s; the watcher
    // re-fires every <10s while the bound pane is in "working" state.
    // Errors are swallowed because typing is purely cosmetic.
    async sendTyping(channelId) {
      try {
        const ch = await client.channels.fetch(channelId);
        if (ch?.sendTyping) await ch.sendTyping();
      } catch {
        /* swallow — typing is cosmetic */
      }
    },

    async getGuild(guildId) {
      return client.guilds.fetch(guildId);
    },

    isAlive() {
      return client.isReady() && client.ws.status === 0;
    },

    stop() {
      client.destroy();
    },
  };
}
