// Normalize Discord.js message objects into channel-agnostic format.
// Pure function, no side effects, fully testable.

const TYPING_INTERVAL_MS = 8000;

/**
 * Normalize a Discord.js Message into a channel-agnostic ChannelMessage.
 * @param {import('discord.js').Message} msg
 * @returns {import('./channel.mjs').ChannelMessage}
 */
export function normalizeDiscordMessage(msg) {
  return {
    channelId: msg.channelId,
    text: msg.content,
    authorId: msg.author.id,
    isBot: msg.author.bot,
    id: msg.id,
    attachments: [...msg.attachments.values()].map((att) => ({
      id: att.id,
      name: att.name,
      url: att.url,
      contentType: att.contentType,
    })),

    reply(content) {
      return msg.reply(content);
    },

    send(content) {
      return msg.channel.send(content);
    },

    startTyping() {
      msg.channel.sendTyping().catch(() => {});
      const interval = setInterval(() => msg.channel.sendTyping().catch(() => {}), TYPING_INTERVAL_MS);
      return () => clearInterval(interval);
    },
  };
}
