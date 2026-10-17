import { basename } from "node:path";
import { createHash } from "node:crypto";
const STATE = "watcher_live_progress";

/** WHAT: Reads per-channel legacy tool display. WHY: Keeps the concise default reversible without changing provider or delivery policy. */
export function toolLinesEnabled(channelId, paneKey, env = process.env) {
  const selected = String(env.AMUX_TOOL_LINES_CHANNELS || "").split(",").map(value => value.trim());
  return selected.includes("*") || selected.includes(String(channelId)) || selected.includes(paneKey);
}

const toolItems = turn => (turn.items || []).filter(item => item.type === "tool" && !["wait", "inter-agent-send"].includes(item.kind));
const keyOf = turn => String(turn.id || turn.timestamp || turn.userAt);
const stepKey = item => item.id || createHash("sha256").update(item.content || "").digest("hex");
const lastStep = item => {
  const label = String(item?.content || "");
  const file = label.match(/^(Read|Edit|Write) (.+)/u);
  if (file) return `${file[1] === "Read" ? "läser" : "ändrar"} ${basename(file[2]).slice(0, 60)}`;
  return /^Search/u.test(label) ? "söker" : /^Run/u.test(label) ? "kör ett kommando" : "arbetar";
};

/** WHAT: Builds one temporary work row per turn and removes it on completion. WHY: Prevents immutable tool updates from becoming hundreds of Discord posts. */
export function createLiveProgress({ discord, state, env = process.env, log = console.warn }) {
  const all = () => state.get(STATE, {}) || {};
  const save = (channelId, value) => { const rows = { ...all() }; if (value) rows[channelId] = value; else delete rows[channelId]; state.set(STATE, rows); };
  async function finish(channelId) {
    const row = all()[channelId];
    if (!row) return;
    try { await discord.deleteMessage(channelId, row.messageId); }
    catch (error) {
      if (Number(error.code) !== 10008) {
        save(channelId, { ...row, finishing: true });
        log(`work row cleanup failed for ${channelId}: ${error.message}`);
        return false;
      }
    }
    save(channelId, null);
    return true;
  }
  async function update({ channelId, paneKey, turn }) {
    if (toolLinesEnabled(channelId, paneKey, env)) { await finish(channelId); return turn; }
    let row = all()[channelId];
    const turnKey = turn.headless && row ? row.turnKey : keyOf(turn);
    if (row && row.turnKey !== turnKey) {
      if (await finish(channelId) === false) return { ...turn, items: (turn.items || []).filter(item => item.type !== "tool") };
      row = null;
    }
    if (turn.isComplete || turn.complete) { await finish(channelId); return { ...turn, items: (turn.items || []).filter(item => item.type !== "tool") }; }
    const tools = toolItems(turn);
    if (tools.length) {
      const seen = new Set(row?.seen || []), fresh = tools.filter(item => !seen.has(stepKey(item)));
      fresh.forEach(item => seen.add(stepKey(item)));
      const count = (row?.count || 0) + fresh.length;
      const latest = fresh.at(-1) ? lastStep(fresh.at(-1)) : row?.latest;
      const text = `Arbetar · ${count} steg · senast: ${latest}`;
      if (!row) {
        const nonce = BigInt(`0x${createHash("sha256").update(`${channelId}:${turnKey}:work`).digest("hex").slice(0, 16)}`).toString();
        const message = await discord.send(channelId, { content: text, nonce, enforceNonce: true }, { kind: "notice" });
        if (!message?.id) throw new Error("work row has no Discord receipt");
        row = { messageId: message.id, turnKey, count, latest, seen: [...seen], rendered: text };
        save(channelId, row);
      } else {
        row = { ...row, count, latest, seen: [...seen].slice(-1000) };
        save(channelId, row);
        if (row.rendered !== text) {
          await discord.editMessage(channelId, row.messageId, text);
          save(channelId, { ...row, rendered: text });
        }
      }
    }
    return { ...turn, items: (turn.items || []).filter(item => item.type !== "tool") };
  }
  return { update, finish, async reconcile(channelId, turns) {
    const row = all()[channelId];
    if (row && (row.finishing || (turns && !turns.some(turn => (keyOf(turn) === row.turnKey || turn.headless) && !turn.isComplete && !turn.complete)))) await finish(channelId);
  } };
}
