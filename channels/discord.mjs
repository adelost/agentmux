// Discord channel adapter. Thin wrapper around discord.js Client.
// All normalization logic lives in normalize.mjs.

import { Client, GatewayIntentBits, Events } from "discord.js";
import { normalizeDiscordMessage } from "./normalize.mjs";

/**
 * Create a Discord channel.
 * @param {{ token: string, onSent?: (channelId: string) => void }} config
 *   onSent fires after any successful outbound message (both from normalized
 *   msg.reply/send and from direct send(channelId, text)). The bridge uses
 *   this to stamp channel_last_mirror_ts in state, enabling the catch-up
 *   notice for stale channels.
 * @returns {import('./channel.mjs').Channel}
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
        if (handler) handler(normalizeDiscordMessage(msg, { onSent }));
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

    /**
     * Messages that arrived while the bridge was DOWN (restart window,
     * crash): everything after `afterId`, oldest first, human-only,
     * age-capped. With no pointer (first boot) nothing is replayed —
     * only the newest id is returned so the caller can initialize.
     * Returns { messages: ChannelMessage[], newestId: string|null }.
     */
    async fetchMissed(channelId, afterId, { limit = 20, maxAgeMs = 60 * 60 * 1000 } = {}) {
      const ch = await client.channels.fetch(channelId);
      if (!ch?.messages) return { messages: [], newestId: afterId || null };
      const coll = afterId
        ? await ch.messages.fetch({ after: afterId, limit })
        : await ch.messages.fetch({ limit: 1 });
      const sorted = [...coll.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      const newestId = sorted.length ? sorted[sorted.length - 1].id : (afterId || null);
      if (!afterId) return { messages: [], newestId }; // init pointer only
      const cutoff = Date.now() - maxAgeMs;
      const messages = sorted
        .filter((m) => !m.author.bot && m.createdTimestamp >= cutoff)
        .map((m) => normalizeDiscordMessage(m, { onSent }));
      return { messages, newestId };
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
