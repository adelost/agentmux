import { createHash } from "node:crypto";
import { sourcePaneChannelName } from "./source-pane-plan.mjs";

/** WHAT: Builds old agent channel bindings. WHY: Keeps preserved Discord history from silently targeting a removed pane. */
export function inactiveChannelBindings(extras, agents, channelMap) {
  const result = {};
  for (const extra of extras) {
    const config = agents.get(extra.agentName);
    if (!config) continue;
    const preferredPane = config.orchestrator ?? (config.codexCount ? config.claudeCount : 0);
    const preferredName = sourcePaneChannelName(extra.agentName, preferredPane, config);
    result[String(extra.id)] = {
      agentName: extra.agentName,
      pane: extra.pane,
      channelName: extra.name,
      redirectId: channelMap.get(preferredName) || null,
      afterId: extra.lastMessageId || null,
    };
  }
  return result;
}

/** WHAT: Formats the actual delivery outcome. WHY: Prevents an old channel from looking like a sleeping agent. */
export function inactiveChannelNotice(target) {
  const next = /^\d+$/u.test(String(target?.redirectId || ""))
    ? ` Skriv i <#${target.redirectId}> i stället.`
    : " Välj en aktiv kanal i samma projekt.";
  return `Den här kanalen är inte längre aktiv. Ingen agent fick ditt meddelande.${next}`;
}

function noticePayload(record) {
  const hex = createHash("sha256").update(`${record.identity}:inactive-channel`).digest("hex").slice(0, 16);
  return {
    content: inactiveChannelNotice(record.target),
    nonce: BigInt(`0x${hex}`).toString(10),
    enforceNonce: true,
  };
}

/** WHAT: Dispatches one reply to the original message. WHY: Prevents a lost acknowledgement from creating repeated warnings. */
export async function sendInactiveChannelNotice(record, store, channel) {
  const effect = "inactive-channel-reply";
  const current = store.read(record.channelId, record.messageId) || record;
  if (!store.beginEffect(current, effect)) return;
  const payload = noticePayload(current);
  if (current.effects?.[effect]?.status === "sending"
      && typeof channel.findMessageByNonce === "function"
      && await channel.findMessageByNonce(current.channelId, payload.nonce, current.messageId)) {
    store.completeEffect(current, effect);
    return;
  }
  if (typeof channel.replyTo !== "function") throw new Error("Inactive channel needs Discord replyTo");
  await channel.replyTo(current.channelId, current.messageId, payload);
  store.completeEffect(current, effect);
}
