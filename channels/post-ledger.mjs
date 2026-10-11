// One recorder for both Discord send points: the bridge's discord.js adapter
// and the CLI's REST posts. Schema, writers and readers: docs/CONVERSATION-LOG.md.

import { appendPostLedger } from "../core/ask-ledger.mjs";
import { runtimeAgentsPath } from "../core/runtime-defaults.mjs";
import { loadConfig } from "../cli/config.mjs";
import { paneForChannel } from "./audio-targets.mjs";

/**
 * WHAT: Records one message amux posted to Discord, with the pane that owns the channel.
 * WHY: The post already happened; a failed record is reported loudly but never becomes a resend.
 */
export function recordDiscordPost({ channelId, payload, message = null, kind, via }, {
  configPath = runtimeAgentsPath(),
  record = appendPostLedger,
  warn = console.warn,
} = {}) {
  try {
    const owner = paneForChannel(loadConfig(configPath), String(channelId));
    return record({ agent: owner?.name ?? null, pane: owner?.pane ?? null, channelId, via, kind, payload,
      messageId: message?.id ?? null });
  } catch (error) {
    warn(`amux: posted to Discord channel ${channelId} but could not record it in the conversation log: ${error.message}`);
    return null;
  }
}
