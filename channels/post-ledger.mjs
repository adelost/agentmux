// One recorder for both Discord send points: the bridge's discord.js adapter
// and the CLI's REST posts. Schema, writers and readers: docs/CONVERSATION-LOG.md.

import { appendPost } from "../core/ask-ledger.mjs";
import { runtimeAgentsPath } from "../core/runtime-defaults.mjs";
import { loadConfig } from "../cli/config.mjs";
import { paneForChannel } from "./audio-targets.mjs";

const failureText = (error) => (error?.code ? `${error.code}: ${error.message}` : error?.message || String(error || "unknown"));

/**
 * WHAT: Records one send attempt to Discord, sent or failed, with the pane that owns the channel.
 * WHY: The attempt already happened; a failed record is reported loudly but never becomes a resend.
 */
export function recordDiscordPost({ channelId, payload, message = null, kind, via, status = "sent", error = null }, {
  configPath = runtimeAgentsPath(),
  record = appendPost,
  warn = console.warn,
} = {}) {
  try {
    const owner = paneForChannel(loadConfig(configPath), String(channelId));
    return record({ agent: owner?.name ?? null, pane: owner?.pane ?? null, channelId, via, kind, payload, status,
      ...(status === "failed" ? { error: failureText(error) } : { messageId: message?.id ?? null }) });
  } catch (error) {
    warn(`amux: posted to Discord channel ${channelId} but could not record it in the conversation log: ${error.message}`);
    return null;
  }
}
