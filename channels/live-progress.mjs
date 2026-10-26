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
  if (file) return `${file[1] === "Read" ? "reading" : "editing"} ${basename(file[2]).slice(0, 60)}`;
  return /^Search/u.test(label) ? "searching" : /^Run/u.test(label) ? "running a command" : "working";
};

const CHANGES = "watcher_changed_files";
const NAME_MAX = 60, CHANGED_MAX = 100, FILES_KEPT = 100, EDITS_KEPT = 200;
const shortName = path => String(path).split(/[\\/]/u).filter(Boolean).at(-1)?.slice(0, NAME_MAX) || "";

/** WHAT: Reads the files one Edit or Write step changed from its label. WHY: Both tools render as `Edit <path>` and a patch of several files as `Edit N files: a | b | +K files`; a shell command that edits through sed or git is not an Edit step, so its files are not named. */
function changedBy(item) {
  const label = String(item?.content || "");
  const many = label.match(/^(?:Edit|Write) \d+ files: (.+)$/u);
  if (many) {
    const parts = many[1].split(" | "), extra = parts.at(-1).match(/^\+(\d+) files$/u);
    return { names: (extra ? parts.slice(0, -1) : parts).map(shortName).filter(Boolean), unnamed: extra ? Number(extra[1]) : 0 };
  }
  const one = label.match(/^(?:Edit|Write) (.+)/u);
  return { names: one && !["file", "files"].includes(one[1]) ? [shortName(one[1])].filter(Boolean) : [], unnamed: 0 };
}

/** WHAT: Renders the changed files as `a.mjs, b.md +3`, or "" when there are none. WHY: The list stops at CHANGED_MAX characters and the rest is a count, so the footer stays one short line. */
function changedText({ files = [], unnamed = 0 }) {
  const shown = [];
  for (const name of files) { if (shown.length && [...shown, name].join(", ").length > CHANGED_MAX) break; shown.push(name); }
  const rest = files.length - shown.length + unnamed;
  return [shown.join(", "), rest ? `+${rest}` : ""].filter(Boolean).join(" ");
}

/** WHAT: Builds one work row per turn, deleted at completion, and tracks changed files for the footer. WHY: Prevents immutable tool updates from becoming hundreds of Discord posts while the answer's footer still says what changed. */
export function createLiveProgress({ discord, state, env = process.env, log = console.warn }) {
  const all = () => state.get(STATE, {}) || {};
  /** The changed files wait per channel, outside the work row, because the row is gone before the final reply and its footer are posted. */
  function noteChanges(channelId, turn, tools) {
    const rows = state.get(CHANGES, {}) || {}, entry = rows[channelId] || { turnKey: null, seen: [], files: [], unnamed: 0 };
    const turnKey = turn.headless && entry.turnKey ? entry.turnKey : keyOf(turn);
    const seen = new Set(entry.turnKey === turnKey ? entry.seen : []), files = [...entry.files];
    let unnamed = entry.unnamed, fresh = false;
    for (const item of tools) {
      const changed = changedBy(item), key = stepKey(item);
      if ((!changed.names.length && !changed.unnamed) || seen.has(key)) continue;
      fresh = true; seen.add(key); unnamed += changed.unnamed;
      for (const name of changed.names) if (!files.includes(name)) { if (files.length < FILES_KEPT) files.push(name); else unnamed++; }
    }
    if (fresh) state.set(CHANGES, { ...rows, [channelId]: { turnKey, seen: [...seen].slice(-EDITS_KEPT), files, unnamed } });
  }
  /** WHAT: Hands over the files changed since the last footer and forgets them. WHY: Each footer names only what changed since the one before it. */
  function takeChanged(channelId) {
    const rows = state.get(CHANGES, {}) || {}, entry = rows[channelId], text = entry ? changedText(entry) : "";
    if (entry && (entry.files.length || entry.unnamed)) state.set(CHANGES, { ...rows, [channelId]: { ...entry, files: [], unnamed: 0 } });
    return text;
  }
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
    noteChanges(channelId, turn, toolItems(turn));
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
      const text = `Working · ${count} step${count === 1 ? "" : "s"} · last: ${latest}`;
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
  return { update, finish, takeChanged, async reconcile(channelId, turns) {
    const row = all()[channelId];
    if (row && (row.finishing || (turns && !turns.some(turn => (keyOf(turn) === row.turnKey || turn.headless) && !turn.isComplete && !turn.complete)))) await finish(channelId);
  } };
}
