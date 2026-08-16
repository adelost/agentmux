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
 * @property {(channelId: string, afterId?: string|null) => Promise<{messages: ChannelMessage[], newestId: string|null}>} [fetchMissed] - Read human messages after a durable cursor.
 * @property {(channelId: string, messageId: string) => Promise<ChannelMessage|null>} [fetchMessage] - Refresh one historical message and its attachment URLs.
 * @property {(channelId: string, messageId: string, content: string|object) => Promise<void>} [replyTo] - Reply to one historical message.
 * @property {(channelId: string, nonce: string, afterId: string) => Promise<boolean>} [findMessageByNonce] - Reconcile one idempotent historical send.
 */

/**
 * @typedef {Object} ChannelMessage
 * @property {string} channelId - Platform-specific channel/chat ID
 * @property {string} text - Message text content
 * @property {string} authorId - Sender's platform ID
 * @property {boolean} isBot - Whether sender is a bot
 * @property {string} id - Message ID (for tmp file naming etc.)
 * @property {number} [createdTimestamp] - Transport-authored creation time;
 *   stable delivery cursor across reconnect retries.
 * @property {Array<{id: string, name: string, url: string, proxyUrl?: string, contentType: string, durablePath?: string|null, sha256?: string|null}>} attachments
 * @property {{agentName: string, pane: number, dir?: string|null}} [resolvedTarget] - Target persisted before expensive work.
 * @property {(chunks: string[]) => Promise<boolean>} [sendTranscriptOnce] - Durable transcript effect using transport-idempotent chunk nonces.
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
