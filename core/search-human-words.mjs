// His messages as Markdown day files, so amux search serves his exact words the way it serves notes: the same units,
// BM25, bge-m3 vectors, reranker and `--show`. The conversation log stays the only source; these files are a derived
// copy that can be deleted and rebuilt (docs/DESIGN-search-daemon.md).
//
// One file per UTC day, `YYYY-MM-DD.md`, one bullet per message:
//   - **05:39:58Z api:0 voice** the words, word for word
//     continuation lines are indented two spaces, so the message stays one unit
// This module is the only writer of the folder. Everything it needs to carry from one sync to the next lives in
// `state.json`, saved only after every day file was written.

import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultAskLedgerPath } from "./ask-ledger.mjs";
import { isHumanAsk } from "./ask-origin.mjs";
import { acquireFileLease } from "./file-lease.mjs";
import { tailLedger } from "./ledger-tail.mjs";
import { humanWordsDir, humanWordsEnabled } from "./search.mjs";
import { authoredPromptText } from "./system-noise.mjs";

const WINDOW_MS = 30 * 86_400_000;
// A sync that found nothing new about his messages saves its place in the log only after this many bytes, so a
// question about the log does not rewrite a megabyte of state to say that agents posted something.
const CHECKPOINT_BYTES = 1024 * 1024;
// The rule of coalesceAskLedger: a pane-hook copy belongs to a delivery of the same words within a quarter of an hour.
const COPY_MATCH_MS = 15 * 60_000;
const STATE_VERSION = 1;
const VOICE_TAG = /^\[transcribed voice[^\]]*\]\s*/u;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/u;

/** WHAT: Returns the words of one of his messages and whether he spoke them. WHY: Keeps every word of his and drops only the bridge's own tag in front of a transcript. */
export function humanMessageText(ask) {
  const authored = authoredPromptText(ask.verbatim);
  const spoken = VOICE_TAG.test(authored);
  return { text: spoken ? authored.replace(VOICE_TAG, "") : authored, spoken };
}

/** WHAT: Formats one message as the bullet of its day file. WHY: Keeps the message one Markdown unit: later lines are indented, so none can start a bullet, heading or table row. */
function bulletOf(ask, { text, spoken }) {
  const [first, ...rest] = text.split("\n");
  const clock = new Date(ask.ts).toISOString().slice(11, 19);
  const lead = `- **${clock}Z ${ask.agent}:${ask.pane}${spoken ? " voice" : ""}** `;
  return `${lead}${[first, ...rest.map((line) => (line ? `  ${line}` : line))].join("\n")}\n`;
}

const dayOf = (ask) => new Date(ask.ts).toISOString().slice(0, 10);
const textHash = (ask) => createHash("sha256").update(authoredPromptText(ask.verbatim)).digest("hex").slice(0, 16);
const sameWords = (entry) => `${entry.agent}\u0000${entry.pane}\u0000${entry.hash}`;

// What a sync remembers of each message of his it has placed, so a later row of the same message, or a copy of it that
// arrives in another sync, is recognised. `claimed` marks a delivery and its copy as one message.
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
 * WHAT: Picks the messages of his that still need a bullet, in time order.
 * WHY: Writes each message once whatever the order its rows arrive in: the same id is skipped, and a delivery and its
 * pane-hook copy are one message. Deliveries are placed before copies so the delivery is the one written.
 */
function messagesToWrite(asks, memory) {
  const isCopy = (ask) => ask.source === "pane-hook";
  const written = [];
  let placed = 0;
  for (const ask of [...asks.filter((row) => !isCopy(row)), ...asks.filter(isCopy)]) {
    if (memory.keys[ask.id]) continue;
    const entry = { agent: ask.agent, pane: ask.pane, hash: textHash(ask), ms: Date.parse(ask.ts), kind: isCopy(ask) ? "copy" : "delivery", claimed: false };
    const partner = nearestUnclaimed(memory, entry, isCopy(ask) ? "delivery" : "copy");
    if (partner) { partner.claimed = true; entry.claimed = true; }
    remember(memory, ask.id, entry);
    placed++;
    if (!partner) written.push(ask);
  }
  return { placed, written: written.sort((left, right) => Date.parse(left.ts) - Date.parse(right.ts)) };
}

function readIfThere(file) {
  try { return readFileSync(file, "utf8"); } catch (error) { if (error.code === "ENOENT") return ""; throw error; }
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
function appendDays(dir, messages, append) {
  const days = new Map();
  for (const ask of messages) {
    const message = humanMessageText(ask);
    if (!message.text) continue;
    const bullets = days.get(dayOf(ask)) || [];
    bullets.push(bulletOf(ask, message));
    days.set(dayOf(ask), bullets);
  }
  let written = 0;
  for (const [day, bullets] of [...days].sort(([left], [right]) => left.localeCompare(right))) {
    const file = join(dir, `${day}.md`);
    const existing = readIfThere(file);
    const lines = `\n${existing}`;
    const missing = bullets.filter((bullet) => !lines.includes(`\n${bullet}`));
    if (!missing.length) continue;
    const opening = existing.trim() ? (existing.endsWith("\n") ? "" : "\n") : `# Human messages, ${day}\n\n`;
    append(file, `${opening}${missing.join("")}`);
    chmodSync(file, 0o600);
    written += missing.length;
  }
  return written;
}

function deleteOldDays(dir, sinceMs) {
  const firstDay = new Date(sinceMs).toISOString().slice(0, 10);
  for (const name of readdirSync(dir)) {
    const day = DAY_FILE.exec(name)?.[1];
    if (day && day < firstDay) rmSync(join(dir, name), { force: true });
  }
}

function loadState(dir) {
  try {
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    if (state?.version === STATE_VERSION && state.tail && state.keys) return state;
  } catch { /* missing or unreadable: the log is read again and the folder is completed from it */ }
  return { version: STATE_VERSION, tail: {}, keys: {} };
}

function saveState(dir, state) {
  const file = join(dir, "state.json");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

function movedBytes(before, after) {
  return Object.entries(after).reduce((sum, [key, entry]) => sum + entry.offset - (before[key]?.offset ?? 0), 0);
}

function syncOwned({ dir, ledgerPath, nowMs, tail, append }) {
  const state = loadState(dir);
  const sinceMs = nowMs - WINDOW_MS;
  const memory = openMemory(state.keys);
  const asks = [];
  let tailState = state.tail;
  for (let done = false; !done;) {
    const tailed = tail(tailState, { path: ledgerPath, sinceMs });
    tailState = tailed.state;
    done = tailed.done;
    for (const { row } of tailed.rows) {
      if (row.event === "ask" && typeof row.verbatim === "string" && isHumanAsk(row) && Date.parse(row.ts) > sinceMs) asks.push(row);
    }
  }
  const { placed, written: messages } = messagesToWrite(asks, memory);
  const written = appendDays(dir, messages, append);
  deleteOldDays(dir, sinceMs);
  let forgotten = 0;
  for (const [id, entry] of Object.entries(memory.keys)) if (entry.ms <= sinceMs) { delete memory.keys[id]; forgotten++; }
  if (placed || forgotten || movedBytes(state.tail, tailState) >= CHECKPOINT_BYTES) {
    saveState(dir, { version: STATE_VERSION, tail: tailState, keys: memory.keys });
  }
  return { written };
}

/**
 * Returns `{ written }`, `{ busy: true }` when another process holds the folder's lease (nothing is changed), or
 * `{ disabled: true }` with AMUX_SEARCH_HUMAN=0. A failed write throws and saves nothing: the next sync does it again.
 * WHAT: Saves his messages from the conversation log as day files, reading only new rows.
 * WHY: Keeps his words searchable the moment he writes them.
 */
export function syncHumanWords({ dir = humanWordsDir(), ledgerPath = defaultAskLedgerPath(), nowMs = Date.now(),
  tail = tailLedger, append = appendText } = {}) {
  if (!humanWordsEnabled()) return { disabled: true };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const lease = acquireFileLease(join(dir, ".lease"));
  if (!lease) return { busy: true };
  try { return syncOwned({ dir, ledgerPath, nowMs, tail, append }); } finally { lease.release(); }
}
