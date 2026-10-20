// His messages as Markdown day files, so amux search serves his exact words the way it serves notes: the same units,
// BM25, bge-m3 vectors, reranker and `--show`. The conversation log stays the only source; these files are a derived
// copy that can be deleted and rebuilt (docs/DESIGN-search-daemon.md). Their form, a bullet per message and a joined
// bullet per run of messages to one pane, is in core/search-human-days.mjs.
//
// This module is the only writer of the folder. Everything it needs to carry from one sync to the next lives in
// `state.json`, saved only after every day file was written. A state of another format, or one made under another name
// of his, means the day files and the state are deleted and written again from the log.

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultAskLedgerPath } from "./ask-ledger.mjs";
import { humanAsksOf, humanMessageText, isHumanAsk, repeatedKeys, repeatKeyOf } from "./ask-origin.mjs";
import { acquireFileLease } from "./file-lease.mjs";
import { tailLedger } from "./ledger-tail.mjs";
import { cleanHumanName, humanWordsDir, humanWordsEnabled } from "./search.mjs";
import { authoredPromptText } from "./system-noise.mjs";
import {
  bulletOf, clockOfMs, DAY_FILE, dayFileName, dayHeading, dayOfMs, dayText, joinedDayText, joinedFileName, parseDay, withoutRepeated,
} from "./search-human-days.mjs";

const WINDOW_MS = 30 * 86_400_000;
// A sync that found nothing new about his messages saves its place in the log only after this many bytes, so a
// question about the log does not rewrite a megabyte of state to say that agents posted something.
const CHECKPOINT_BYTES = 1024 * 1024;
// The rule of coalesceAskLedger: a pane-hook copy belongs to a delivery of the same words within a quarter of an hour.
const COPY_MATCH_MS = 15 * 60_000;
// 2: the header carries his name, the joined files exist, and a text repeated three times is not his.
const STATE_VERSION = 2;

const textHash = (ask) => createHash("sha256").update(authoredPromptText(ask.verbatim)).digest("hex").slice(0, 16);
const sameWords = (entry) => `${entry.agent}\u0000${entry.pane}\u0000${entry.hash}`;
const dayOf = (ask) => dayOfMs(Date.parse(ask.ts));

// What a sync remembers of each message of his it has placed, so a later row of the same message, or a copy of it that
// arrives in another sync, is recognised. `claimed` marks a delivery and its copy as one message. `rk` names the words
// of a message that is long enough to be repeated; `gone` marks a message that is not in any day file because its
// words turned out to be a repeated prompt.
function openMemory(keys) {
  const groups = new Map();
  for (const entry of Object.values(keys)) {
    const group = groups.get(sameWords(entry));
    if (group) group.push(entry); else groups.set(sameWords(entry), [entry]);
  }
  return { keys, groups };
}

function remember(memory, id, entry) {
  memory.keys[id] = entry;
  const group = memory.groups.get(sameWords(entry));
  if (group) group.push(entry); else memory.groups.set(sameWords(entry), [entry]);
}

const nearestUnclaimed = (memory, entry, kind) => (memory.groups.get(sameWords(entry)) || [])
  .filter((other) => other.kind === kind && !other.claimed && Math.abs(other.ms - entry.ms) <= COPY_MATCH_MS)
  .sort((left, right) => Math.abs(left.ms - entry.ms) - Math.abs(right.ms - entry.ms))[0];

/**
 * WHAT: Places new asks in memory and returns the ones that are messages of their own, in time order.
 * WHY: Counts each message once whatever the order its rows arrive in: the same id is skipped, and a delivery and its
 * pane-hook copy are one message. Deliveries are placed before copies so the delivery is the one written.
 */
function placeMessages(asks, memory) {
  const isCopy = (ask) => ask.source === "pane-hook";
  const messages = [];
  let placed = 0;
  for (const ask of [...asks.filter((row) => !isCopy(row)), ...asks.filter(isCopy)]) {
    if (memory.keys[ask.id]) continue;
    const entry = { agent: ask.agent, pane: ask.pane, hash: textHash(ask), ms: Date.parse(ask.ts), kind: isCopy(ask) ? "copy" : "delivery", claimed: false };
    const partner = nearestUnclaimed(memory, entry, isCopy(ask) ? "delivery" : "copy");
    if (partner) { partner.claimed = true; entry.claimed = true; } else {
      const rk = repeatKeyOf(ask);
      if (rk) entry.rk = rk;
      messages.push(ask);
    }
    remember(memory, ask.id, entry);
    placed++;
  }
  return { placed, messages: messages.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts)) };
}

function readIfThere(file) {
  try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
}

/** WHAT: Writes a whole file under a temporary name and renames it into place. WHY: Keeps a reader, and a crash, from ever seeing half of a day file that was rewritten. */
function writeWhole(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** WHAT: Appends text to a day file and gives it back unchanged if the write fails. WHY: Keeps a full disk from leaving half a bullet that the next bullet would be glued to. */
function appendText(file, text) {
  const before = existsSync(file) ? statSync(file).size : 0;
  try { appendFileSync(file, text, { mode: 0o600 }); } catch (error) {
    try { truncateSync(file, before); } catch { /* nothing was written, or the file is gone */ }
    throw error;
  }
}

// A bullet already in the file is not written again, so a sync that stopped before it saved its state can run again.
function appendDays(dir, messages, append, name) {
  const days = new Map();
  for (const ask of messages) {
    const message = humanMessageText(ask);
    if (!message.text) continue;
    const bullets = days.get(dayOf(ask)) || [];
    bullets.push(bulletOf(ask, message, name));
    days.set(dayOf(ask), bullets);
  }
  let written = 0;
  for (const [day, bullets] of [...days].sort(([left], [right]) => left.localeCompare(right))) {
    const file = join(dir, dayFileName(day));
    const existing = readIfThere(file);
    const lines = `\n${existing}`;
    const missing = bullets.filter((bullet) => !lines.includes(`\n${bullet}`));
    if (!missing.length) continue;
    const opening = existing.trim() ? (existing.endsWith("\n") ? "" : "\n") : dayHeading(day);
    append(file, `${opening}${missing.join("")}`);
    chmodSync(file, 0o600);
    written += missing.length;
  }
  return written;
}

// A text that reaches its third copy is not his: the copies written before leave their day files, and the files that
// lost a bullet are the ones whose joined file has to be made again.
function takeOutRepeated(dir, memory, repeated, name) {
  const gone = Object.values(memory.keys).filter((entry) => entry.rk && repeated.has(entry.rk) && !entry.gone);
  const byDay = new Map();
  for (const entry of gone) {
    entry.gone = true;
    const day = dayOfMs(entry.ms);
    byDay.set(day, [...(byDay.get(day) || []), { key: entry.rk, clock: clockOfMs(entry.ms), address: `${entry.agent}:${entry.pane}` }]);
  }
  for (const [day, entries] of byDay) {
    const file = join(dir, dayFileName(day));
    const left = withoutRepeated(parseDay(readIfThere(file), name), entries);
    if (!left.changed) continue;
    if (left.bullets.length) writeWhole(file, dayText(left.head, left.bullets)); else rmSync(file, { force: true });
  }
  return new Set(byDay.keys());
}

function rewriteJoined(dir, days, name) {
  for (const day of [...days].sort()) {
    const joined = joinedDayText(day, parseDay(readIfThere(join(dir, dayFileName(day))), name).bullets, name);
    const file = join(dir, joinedFileName(day));
    if (!joined) rmSync(file, { force: true });
    else if (readIfThere(file) !== joined) writeWhole(file, joined);
  }
}

function deleteOldDays(dir, sinceMs) {
  const firstDay = new Date(sinceMs).toISOString().slice(0, 10);
  for (const name of readdirSync(dir)) {
    const day = DAY_FILE.exec(name)?.[1];
    if (day && day < firstDay) rmSync(join(dir, name), { force: true });
  }
}

function readState(dir) {
  try {
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    if (state?.tail && state.keys) return state;
  } catch { /* missing or unreadable: the log is read again and the folder is completed from it */ }
  return null;
}

// The day files and the state go; the state last, so a sync that stopped halfway still finds the old format and starts over.
function wipeFolder(dir) {
  for (const entry of readdirSync(dir)) if (DAY_FILE.test(entry)) rmSync(join(dir, entry), { force: true });
  rmSync(join(dir, "state.json"), { force: true });
}

// `name` undefined means the caller does not know his name, and the state keeps the one it has.
function openState(dir, name) {
  let state = readState(dir);
  const wanted = name === undefined ? undefined : cleanHumanName(name);
  const changed = Boolean(state) && (state.version !== STATE_VERSION || (wanted !== undefined && (state.name ?? "") !== wanted));
  if (changed) { wipeFolder(dir); state = null; }
  return { state: state || { version: STATE_VERSION, name: wanted ?? "", tail: {}, keys: {} }, wiped: changed };
}

function saveState(dir, state) {
  writeWhole(join(dir, "state.json"), JSON.stringify(state));
}

function movedBytes(before, after) {
  return Object.entries(after).reduce((sum, [key, entry]) => sum + entry.offset - (before[key]?.offset ?? 0), 0);
}

function newHumanAsks(tail, tailState, { path, sinceMs }) {
  const asks = [];
  let next = tailState;
  for (let done = false; !done;) {
    const tailed = tail(next, { path, sinceMs });
    next = tailed.state;
    done = tailed.done;
    for (const { row } of tailed.rows) {
      if (row.event === "ask" && typeof row.verbatim === "string" && isHumanAsk(row) && Date.parse(row.ts) > sinceMs) asks.push(row);
    }
  }
  return { asks, tailState: next };
}

function syncOwned({ dir, ledgerPath, nowMs, tail, append, name }) {
  const { state, wiped } = openState(dir, name);
  const sinceMs = nowMs - WINDOW_MS;
  const memory = openMemory(state.keys);
  const earlier = Object.values(memory.keys).filter((entry) => entry.rk && entry.ms > sinceMs).map((entry) => entry.rk);
  const { asks, tailState } = newHumanAsks(tail, state.tail, { path: ledgerPath, sinceMs });
  const { placed, messages } = placeMessages(asks, memory);
  const kept = humanAsksOf(messages, { earlier });
  const keptIds = new Set(kept.map((ask) => ask.id));
  for (const ask of messages) if (!keptIds.has(ask.id)) memory.keys[ask.id].gone = true;
  const written = appendDays(dir, kept, append, state.name);
  const repeated = repeatedKeys([...earlier, ...messages.map(repeatKeyOf)]);
  const changedDays = takeOutRepeated(dir, memory, repeated, state.name);
  for (const ask of kept) changedDays.add(dayOf(ask));
  rewriteJoined(dir, changedDays, state.name);
  deleteOldDays(dir, sinceMs);
  let forgotten = 0;
  for (const [id, entry] of Object.entries(memory.keys)) if (entry.ms <= sinceMs) { delete memory.keys[id]; forgotten++; }
  if (wiped || placed || forgotten || movedBytes(state.tail, tailState) >= CHECKPOINT_BYTES) {
    saveState(dir, { version: STATE_VERSION, name: state.name, tail: tailState, keys: memory.keys });
  }
  return { written };
}

/**
 * Returns `{ written }`, `{ busy: true }` when another process holds the folder's lease (nothing is changed), or
 * `{ disabled: true }` with AMUX_SEARCH_HUMAN=0. A failed write throws and saves nothing: the next sync does it again.
 * `name` is the name his headers carry (from `human.name`); leave it out and the state keeps the name it has.
 * WHAT: Saves his messages from the conversation log as day files, reading only new rows.
 * WHY: Keeps his words searchable the moment he writes them.
 */
export function syncHumanWords({ dir = humanWordsDir(), ledgerPath = defaultAskLedgerPath(), nowMs = Date.now(),
  tail = tailLedger, append = appendText, name } = {}) {
  if (!humanWordsEnabled()) return { disabled: true };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lease = acquireFileLease(join(dir, ".lease"));
  if (!lease) return { busy: true };
  try { return syncOwned({ dir, ledgerPath, nowMs, tail, append, name }); } finally { lease.release(); }
}
