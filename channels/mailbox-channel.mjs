// Discord channels that talk to an agent on another computer through an api.v1d.io mailbox (row 211, gateway 14z352): a human message in the
// channel goes into the box, voice transcribed as for a pane, and what the far side writes back is posted in the channel. The far side is
// bin/agent-relay.mjs. The bridge's pane routing never sees these channels.

import { existsSync, readFileSync } from "node:fs";

const WAIT_S = 50, DISCORD_CHARS = 1900;

/** WHAT: Reads the mailbox channels from their file. WHY: Each names its channel, its box and the Discord users who may write to it; a
 *  missing file means no mailbox channel, and a broken one is said once, never guessed. */
export function loadMailboxChannels(path) {
  if (!existsSync(path)) return null;
  const config = JSON.parse(readFileSync(path, "utf8"));
  const boxes = (config.boxes || []).filter((box) => /^mbx_[a-f0-9]{32}$/.test(box.box) && box.channelId && box.authors?.length);
  if (boxes.length !== (config.boxes || []).length) throw new Error(`${path}: every box needs box (mbx_…), channelId and authors`);
  return { api: config.api || "https://api.v1d.io", boxes };
}

/** WHAT: The bridge's side of every mailbox channel. WHY: One owner for the inbound and outbound halves and their cursors, so a restart
 *  neither loses a human message (catch-up from the last one delivered) nor posts an answer twice (the box's last number read). */
export function createMailboxChannels({ config, ownerKey, channel, buildPrompt, state, fetchImpl = fetch, log = console }) {
  const byChannel = new Map(config.boxes.map((box) => [box.channelId, box]));
  const cursors = () => state.get("mailboxChannels", {});
  const remember = (box, patch) => state.set("mailboxChannels", { ...cursors(), [box.box]: { ...cursors()[box.box], ...patch } });
  const call = async (box, method, query = "", body) => {
    const response = await fetchImpl(`${config.api}/v1/mailboxes/${box.box}/messages${query}`, {
      method, headers: { Authorization: `Bearer ${ownerKey}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout((WAIT_S + 20) * 1000),
    });
    if (!response.ok) throw new Error(`api.v1d.io answered ${response.status} for ${box.label || box.box}`);
    return response.json();
  };

  /** A human message from an allowed author goes into the box; the far side's answer comes back by the poll. */
  async function deliver(msg) {
    const box = byChannel.get(msg.channelId);
    if (!box || msg.isBot || !box.authors.includes(msg.authorId)) return { ignored: true };
    try {
      const text = (await buildPrompt(msg))?.trim();
      if (text) await call(box, "POST", "", { text });
      remember(box, { lastMessageId: msg.id });
      return { delivered: Boolean(text) };
    } catch (error) {
      log.warn(`mailbox ${box.label || box.box}: delivery failed, ${error.message}`);
      await msg.reply(`Not delivered to ${box.label || "the far side"}: ${error.message}. Send it again.`).catch(() => {});
      return { failed: true };
    }
  }

  /** Posts what the far side wrote, in Discord-sized parts, moving the cursor only past what was posted. */
  async function pollOnce(box) {
    const after = cursors()[box.box]?.after ?? 0;
    const letters = await call(box, "GET", `?after=${after}&wait=${WAIT_S}`);
    for (const letter of letters.data) {
      for (const part of discordParts(letter.text)) await channel.send(box.channelId, part);
      remember(box, { after: letter.seq });
    }
  }

  /** Human messages written while the bridge was down, after the last one delivered. */
  async function catchUp(box) {
    const afterId = cursors()[box.box]?.lastMessageId;
    if (!afterId || typeof channel.fetchMissed !== "function") return;
    const { messages } = await channel.fetchMissed(box.channelId, afterId);
    for (const msg of messages) await deliver(msg);
  }

  function start() {
    for (const box of config.boxes) {
      void (async () => {
        await catchUp(box).catch((error) => log.warn(`mailbox ${box.label || box.box}: catch-up failed, ${error.message}`));
        for (;;) {
          try { await pollOnce(box); }
          catch (error) { log.warn(`mailbox ${box.label || box.box}: poll failed, ${error.message}`); await new Promise((r) => setTimeout(r, 10_000)); }
        }
      })();
    }
    log.log(`mailbox channels: ${config.boxes.map((box) => `${box.label || box.box} -> #${box.channelId}`).join(", ")}`);
  }

  return { owns: (channelId) => byChannel.has(channelId), deliver, pollOnce, start };
}

/** WHAT: Splits a long answer for Discord. WHY: A post over 2000 characters is refused (50035); lines are kept whole where they fit. */
export function discordParts(text) {
  const parts = [];
  let rest = text;
  while (rest.length > DISCORD_CHARS) {
    const cut = rest.lastIndexOf("\n", DISCORD_CHARS);
    const at = cut > DISCORD_CHARS / 2 ? cut : DISCORD_CHARS;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, "");
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}
