// Discord channel adapter. Thin wrapper around discord.js Client.
// All normalization logic lives in normalize.mjs.

import { Client, GatewayIntentBits, Events } from "discord.js";
import { normalizeDiscordMessage } from "./normalize.mjs";

/**
 * Create a Discord channel.
 * @param {{ token: string }} config
 * @returns {import('./channel.mjs').Channel}
 */
export function createDiscordChannel({ token }) {
  let handler = null;
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
        if (handler) handler(normalizeDiscordMessage(msg));
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
      if (ch) await ch.send(text);
    },

    stop() {
      client.destroy();
    },
  };
}
