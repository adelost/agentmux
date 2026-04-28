// Channel interface contract and runtime validation.
//
// A Channel connects to a messaging platform and delivers normalized messages.
// Implementations: channels/discord.mjs (more to come).

/**
 * @typedef {Object} Channel
 * @property {string} name - Platform identifier (e.g. 'discord', 'telegram')
 * @property {(callback: (msg: ChannelMessage) => void) => void} onMessage - Register incoming message handler
 * @property {() => Promise<{user?: string}>} start - Connect. Resolves with connection info when ready.
 * @property {() => void} stop - Disconnect and cleanup
 * @property {(channelId: string, text: string) => Promise<void>} send - Post text to channel
 * @property {(channelId: string) => Promise<void>} [sendTyping] - Show typing indicator (~10s on Discord). Optional; channels that lack a typing primitive should omit.
 */

/**
 * @typedef {Object} ChannelMessage
 * @property {string} channelId - Platform-specific channel/chat ID
 * @property {string} text - Message text content
 * @property {string} authorId - Sender's platform ID
 * @property {boolean} isBot - Whether sender is a bot
 * @property {string} id - Message ID (for tmp file naming etc.)
 * @property {Array<{id: string, name: string, url: string, contentType: string}>} attachments
 * @property {(content: string|object) => Promise<void>} reply - Reply to this message
 * @property {(content: string|object) => Promise<void>} send - Send to the channel (not as reply)
 * @property {() => () => void} startTyping - Show typing indicator, returns stop function
 */

const REQUIRED = ["name", "onMessage", "start", "stop"];

/**
 * Validate that an object implements the Channel interface.
 * @param {object} ch
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateChannel(ch) {
  if (!ch || typeof ch !== "object") {
    return { valid: false, missing: REQUIRED };
  }
  const missing = REQUIRED.filter((key) => {
    if (key === "name") return typeof ch[key] !== "string";
    return typeof ch[key] !== "function";
  });
  return { valid: missing.length === 0, missing };
}
