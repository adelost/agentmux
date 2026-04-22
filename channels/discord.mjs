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
      if (ch) {
        await ch.send(text);
        stamp(channelId);
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
