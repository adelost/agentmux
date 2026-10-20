// Finds the panes that went quiet, and remembers what amux already did about each (docs/DESIGN-quiet-panes.md,
// chapters 4 and 6). An episode is a pane's turn-final reply that no ask and no later output followed for 3 minutes,
// or for 20 when the reply leaves work with no blocker.
// Its key is the pane plus the pane's own waiting line, so the same line in later replies is the same episode.
// This module is the only writer of quiet-seen.json and quiet-hands.json.

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DREAM_ANSWER_KINDS } from "./dream-conversation.mjs";
import { classifyQuiet, normalizedLine } from "./quiet-classify.mjs";
import { operatorName } from "./runtime-defaults.mjs";

/** WHAT: Defines how long a pane must give no sign of work before it counts as quiet. WHY: Keeps a pane between two tool calls from being judged. */
export const QUIET_AFTER_MS = 3 * 60_000;
/**
 * In the replay of 2026-10-20 06:00 to 10:00Z, 13 of the 14 panes nudged after 3 quiet minutes went on by themselves
 * within 3 to 15 minutes (their own background jobs, other panes' asks); the one real stop stayed quiet for 155 minutes.
 * WHAT: Defines how long a pane with work left stays quiet before its lead is told.
 * WHY: Keeps a pane that waits on its own job from being reported as stopped (design v4).
 */
export const LEFT_QUIET_MS = 20 * 60_000;

const quietNeedMs = (verdict, quietMs) => (verdict.class === "left" ? Math.max(quietMs, LEFT_QUIET_MS) : quietMs);
/** WHAT: Defines how far back the cron reads the conversation log. WHY: Limits one run to a tail of the log, not the whole of it. */
export const SCAN_MS = 6 * 3_600_000;
/** WHAT: Defines how long a pane may show no ledger row before it counts as dormant. WHY: Keeps a message from waking a pane nobody uses. */
export const DORMANT_MS = 2 * 3_600_000;

// Discord holds 2 000 characters, so a longer reply is posted in chunks about half a second apart.
const CHUNK_GAP_MS = 2_500;
const CHUNK_MIN_CHARS = 1_500;
const SEEN_KEEP_MS = 24 * 3_600_000;

const paneOf = (row) => `${row.agent}:${row.pane}`;
const timeOf = (row) => Date.parse(row.ts);

function rowsByPane({ asks = [], posts = [] }) {
  const panes = new Map();
  const add = (row, kind) => {
    const key = paneOf(row);
    if (!panes.has(key)) panes.set(key, []);
    panes.get(key).push({ ms: timeOf(row), kind, row });
  };
  for (const ask of asks) add(ask, "ask");
  for (const post of posts) add(post, "post");
  for (const rows of panes.values()) rows.sort((left, right) => left.ms - right.ms);
  return panes;
}

// The turn-final replies of one pane. An ask, or output of the pane's own after a reply (another reply, a file, a
// voice note), ends it; a footer, a mirror and a failed post do not.
function replyUnits(rows) {
  const units = [];
  let open = null;
  const close = (ms) => { if (open) open.endedMs = ms; open = null; };
  for (const { ms, kind, row } of rows) {
    if (kind === "ask") { close(ms); continue; }
    if (row.status === "failed" || !DREAM_ANSWER_KINDS.has(row.kind)) continue;
    const isChunk = open && row.kind === "reply" && ms - open.endMs <= CHUNK_GAP_MS && open.lastChars >= CHUNK_MIN_CHARS;
    if (isChunk) {
      Object.assign(open, { reply: `${open.reply}\n${row.text}`, endMs: ms, lastChars: row.text.length });
      continue;
    }
    close(ms);
    if (row.kind !== "reply") continue;
    open = { replyId: row.id, reply: row.text, startMs: ms, endMs: ms, lastChars: row.text.length, endedMs: null };
    units.push(open);
  }
  return units;
}

/** WHAT: Names the episode of a reply by its pane and waiting line. WHY: Keeps a repeated line on one key, and a reply with none on its own. */
export function episodeKey(pane, verdict, replyId) {
  const basis = verdict.line ? normalizedLine(verdict.line) : String(replyId);
  return `quiet:${pane}:${createHash("sha256").update(basis).digest("hex").slice(0, 10)}`;
}

/**
 * `isParked(pane, unit)` says whether the quota park held the pane at that reply. An episode that a later ask or output
 * ended is returned too, with `endedMs` set; an open one has `endedMs` null. `sinceMs` is the first reply with the same key.
 * WHAT: Collects every reply left quiet long enough for its class, with its class and key.
 * WHY: Keeps the cron and the replay on one definition of a quiet pane.
 */
export function quietEpisodes(log, { untilMs, quietMs = QUIET_AFTER_MS, operator = operatorName(), isParked = () => false } = {}) {
  const episodes = [];
  for (const [pane, rows] of rowsByPane(log)) {
    const [agent, paneIndex] = [pane.slice(0, pane.lastIndexOf(":")), Number(pane.slice(pane.lastIndexOf(":") + 1))];
    const units = replyUnits(rows).map((unit) => {
      const verdict = classifyQuiet(unit.reply, { parked: isParked(pane, unit), operator });
      const needMs = quietNeedMs(verdict, quietMs);
      return { ...unit, pane, agent, paneIndex, verdict, key: episodeKey(pane, verdict, unit.replyId), needMs, quietFromMs: unit.endMs + needMs };
    });
    const first = new Map();
    for (const unit of units) if (!first.has(unit.key)) first.set(unit.key, unit.startMs);
    for (const { needMs, ...unit } of units) {
      if ((unit.endedMs ?? untilMs) - unit.endMs >= needMs) episodes.push({ ...unit, sinceMs: first.get(unit.key) });
    }
  }
  return episodes.sort((left, right) => left.quietFromMs - right.quietFromMs);
}

/** WHAT: Filters the episodes to the panes that are quiet right now. WHY: Keeps a pane that was asked again out of the cron's work. */
export const openEpisodes = (episodes) => episodes.filter((episode) => episode.endedMs === null);

/** WHAT: Filters out the episodes whose key amux has already acted on. WHY: Keeps three replies with one line to one forward. */
export const unsentEpisodes = (episodes, seen) => episodes.filter((episode) => !(episode.key in seen));

/**
 * `lastRowAt` is the time of a pane's newest row of any kind at or before a moment, and -Infinity when it has none.
 * WHAT: Indexes the log by pane for the questions the planner asks of it.
 * WHY: Lets the dormant-pane rule and the answered-by rule read one sorted list per pane.
 */
export function indexLedger(log) {
  const panes = rowsByPane(log);
  return {
    lastRowAt: (pane, atMs) => (panes.get(pane) ?? []).findLast(({ ms }) => ms <= atMs)?.ms ?? -Infinity,
    asksAfter: (pane, afterMs, untilMs = Infinity) => (panes.get(pane) ?? [])
      .filter(({ kind, ms }) => kind === "ask" && ms > afterMs && ms <= untilMs).map(({ row }) => row),
  };
}

/** WHAT: Resolves the file that remembers which keys amux already sent. WHY: Lets a test or a dry run point it at a folder of its own. */
export const defaultQuietSeenPath = (home = homedir()) => process.env.AMUX_QUIET_SEEN_PATH || join(home, ".agentmux", "quiet-seen.json");
/** WHAT: Resolves the file that lists the panes waiting for his hands. WHY: Lets a test or a dry run point it at a folder of its own. */
export const defaultQuietHandsPath = (home = homedir()) => process.env.AMUX_QUIET_HANDS_PATH || join(home, ".agentmux", "quiet-hands.json");

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")) ?? {}; } catch (error) {
    if (error.code === "ENOENT") return {};
    // A damaged file is derived and may be deleted, but never guessed: sending again after a guess could duplicate a message.
    throw new Error(`${path} is not valid JSON (${error.message}); it is derived, so delete it to start again`);
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

/**
 * `seen` maps a key to {at, state: sent|unknown|failed, target, kind, since, attempts}; a key of a day ago is forgotten.
 * `hands` maps a pane to {since, line, what, key}. Both files are mode 600 and written whole through a rename.
 * WHAT: Stores the keys amux already sent and the panes that wait for his hands.
 * WHY: Keeps a late or double cron run from sending a second message.
 */
export function createQuietStore({ seenPath = defaultQuietSeenPath(), handsPath = defaultQuietHandsPath(), now = Date.now } = {}) {
  return {
    seen: () => readJson(seenPath),
    markSeen(key, entry) {
      const kept = Object.fromEntries(Object.entries(readJson(seenPath)).filter(([, old]) => now() - old.at <= SEEN_KEEP_MS));
      writeJson(seenPath, { ...kept, [key]: entry });
    },
    hands: () => readJson(handsPath),
    setHands: (hands) => writeJson(handsPath, hands),
  };
}
