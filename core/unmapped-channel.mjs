// A human message in an amux pane channel that maps to no pane gets an answer,
// not silence. #ai-8-qwen and #claw-8-qwen were synced amux channels missing
// from the runtime channel map: their messages waited unseen from 2026-10-01
// until a config regeneration on 2026-10-15 mapped them again.

import { createHash } from "node:crypto";

/** WHAT: Names the synced amux channel a message came from. WHY: Keeps notices inside amux pane channels and away from other guild channels. */
export function syncedAmuxChannelName(syncedChannels, channelId) {
  const id = String(channelId || "");
  if (!id) return null;
  const found = Object.entries(syncedChannels || {}).find(([, known]) => String(known) === id);
  return found ? found[0] : null;
}

/** WHAT: Formats the answer to a message in an unmapped amux channel. WHY: The person learns at once that no agent got it, instead of waiting days for a reply. */
export function unmappedChannelNotice(channelName) {
  return `#${channelName} is missing from the amux channel map, so no agent has got your message yet. Write in another pane's channel for now.`;
}

function noticePayload(msg, channelName) {
  const hex = createHash("sha256").update(`${msg.channelId}:${msg.id}:unmapped-channel`).digest("hex").slice(0, 16);
  return { content: unmappedChannelNotice(channelName), nonce: BigInt(`0x${hex}`).toString(10), enforceNonce: true };
}

/** WHAT: Dispatches one reply to a message in an unmapped amux channel. WHY: Prevents a repeated Gateway event from stacking the warning; the nonce comes from the message. */
export async function sendUnmappedChannelNotice(channel, msg, channelName) {
  const payload = noticePayload(msg, channelName);
  const post = { kind: "notice" };
  if (typeof msg.reply === "function") return msg.reply(payload, post);
  if (typeof channel?.replyTo === "function") return channel.replyTo(msg.channelId, msg.id, payload, post);
  throw new Error(`Unmapped channel #${channelName} needs a Discord reply`);
}

/**
 * WHAT: Builds the hook answering human messages that resolve to no pane.
 * WHY: Separates a broken mapping of an amux channel from someone else's channel.
 */
export function createUnmappedChannelAnswer({ syncedChannels, log = console.warn }) {
  return async (msg, channel) => {
    const name = syncedAmuxChannelName(syncedChannels(), msg?.channelId);
    if (!name) return false;
    log(`[inbound] #${name} (${msg.channelId}) has no pane mapping; answered with a notice`);
    await sendUnmappedChannelNotice(channel, msg, name);
    return true;
  };
}
