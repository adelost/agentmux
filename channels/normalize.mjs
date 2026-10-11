// Normalize Discord.js message objects into channel-agnostic format.
// Pure function, no side effects, fully testable.

const TYPING_INTERVAL_MS = 8000;

/**
 * Normalize a Discord.js Message into a channel-agnostic ChannelMessage.
 *
 * @param {import('discord.js').Message} msg
 * @param {{ onSent?: (channelId: string) => void }} [opts]
 *   onSent fires after any successful reply/send. The bridge stamps the
 *   last-mirror timestamp per channel here, which powers the catch-up
 *   notice ("ℹ N turns since your last Discord sync") on the next
 *   inbound message. Failures in the callback are swallowed so a broken
 *   stamper can't break message delivery.
 * @returns {import('./channel.mjs').ChannelMessage}
 */
export function normalizeDiscordMessage(msg, opts = {}) {
  const onSent = opts.onSent;
  const stamp = (post) => { if (onSent) { try { onSent(msg.channelId, post); } catch {} } };

  return {
    channelId: msg.channelId,
    text: msg.content,
    authorId: msg.author.id,
    isBot: msg.author.bot,
    id: msg.id,
    createdTimestamp: msg.createdTimestamp,
    attachments: [...msg.attachments.values()].map((att) => ({
      id: att.id,
      name: att.name,
      url: att.url,
      proxyUrl: att.proxyURL || null,
      contentType: att.contentType,
    })),

    async reply(content, { kind } = {}) {
      let r;
      try { r = await msg.reply(content); }
      catch (error) { stamp({ payload: content, kind, status: "failed", error }); throw error; }
      stamp({ payload: content, message: r, kind, status: "sent" });
      return r;
    },

    async send(content, { kind } = {}) {
      let r;
      try { r = await msg.channel.send(content); }
      catch (error) { stamp({ payload: content, kind, status: "failed", error }); throw error; }
      stamp({ payload: content, message: r, kind, status: "sent" });
      return r;
    },

    startTyping() {
      msg.channel.sendTyping().catch(() => {});
      const interval = setInterval(() => msg.channel.sendTyping().catch(() => {}), TYPING_INTERVAL_MS);
      return () => clearInterval(interval);
    },
  };
}
