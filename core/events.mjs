// Event ledger: panes PUSH their own state transitions via Claude Code hooks
// (bin/amux-hook.mjs) instead of amux inferring state by scraping tmux and
// tailing session jsonl. One append-only file; readers derive per-pane state
// from the newest event. This is the root-cause fix for the
// misclassification bug class (working/idle/needs-you guessed wrong from
// terminal rendering).
//
// File format: one JSON object per line, append-only:
//   {"ts":"2026-07-08T12:00:00.000Z","event":"stop","session":"claw",
//    "pane":1,"cwd":"/…/.agents/1","sessionId":"…","detail":""}
//
// Writers: the hook script (one line per turn boundary — cheap, atomic
// O_APPEND). Rotation: append() truncates to the newest half when the file
// exceeds MAX_BYTES; best-effort and loss-tolerant (events are hints with
// short useful lifetimes, jsonl/tmux remain the deep source of truth).

import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_LINES_ON_ROTATE = 4000;

/** Claude Code hook_event_name -> ledger event. Unknown events are dropped. */
export const HOOK_EVENT_MAP = {
  UserPromptSubmit: "prompt",   // a turn started: pane is working
  Stop: "stop",                 // turn finished: pane is idle
  Notification: "notification", // needs the human (permission / attention)
  SessionStart: "session_start",
};

export function eventsPath() {
  return process.env.AMUX_EVENTS_PATH || join(homedir(), ".agentmux", "events.jsonl");
}

/** "/path/to/sock,1234,0" (the $TMUX env var) -> socket path, or null. */
export function parseTmuxSocket(tmuxEnv) {
  const sock = String(tmuxEnv || "").split(",")[0].trim();
  return sock || null;
}

/**
 * Build a ledger event from a Claude Code hook payload + resolved pane.
 * Returns null for events we don't track (keeps the hook script dumb).
 */
export function buildEvent(hookPayload, paneInfo, now = new Date()) {
  const event = HOOK_EVENT_MAP[hookPayload?.hook_event_name];
  if (!event || !paneInfo?.session) return null;
  return {
    ts: now.toISOString(),
    event,
    session: paneInfo.session,
    pane: Number(paneInfo.pane) || 0,
    cwd: hookPayload.cwd || "",
    sessionId: hookPayload.session_id || "",
    detail: String(hookPayload.message || "").slice(0, 200),
  };
}

export function appendEvent(evt, path = eventsPath()) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(evt) + "\n");
  rotateIfNeeded(path);
}

function rotateIfNeeded(path) {
  try {
    if (statSync(path).size <= MAX_BYTES) return;
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const kept = lines.slice(-KEEP_LINES_ON_ROTATE);
    // Write-then-rename so a concurrent appender can at worst lose its own
    // single line, never corrupt the file.
    const tmp = path + ".rotate";
    writeFileSync(tmp, kept.join("\n") + "\n");
    renameSync(tmp, path);
  } catch {
    // Rotation is best-effort; appends must never fail because of it.
  }
}

/** All parseable events, oldest first. Corrupt lines are skipped, not fatal. */
export function readEvents({ since = null, path = eventsPath() } = {}) {
  if (!existsSync(path)) return [];
  const cutoff = since ? new Date(since).getTime() : null;
  const events = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const evt = JSON.parse(line);
      if (cutoff && new Date(evt.ts).getTime() < cutoff) continue;
      events.push(evt);
    } catch {
      // half-written or corrupt line: skip
    }
  }
  return events;
}

/**
 * Newest pushed state per pane: Map "session:pane" -> { state, ts, detail }.
 *
 *   prompt        -> working
 *   stop          -> idle
 *   notification  -> needs_you
 *   session_start -> idle (fresh spawn, no turn yet)
 *
 * maxAgeMs guards against stale truth: a hook that stopped firing (pane
 * killed, hooks uninstalled) must not pin a pane's state forever. Older
 * entries are omitted — callers fall back to the scraping path.
 */
/**
 * Merge a tmux-scraped status with a hook-pushed state. Deliberately
 * monotone-safe: pushed events only ADD information where scraping saw
 * nothing, they never contradict a live observation.
 *
 *   - Scraped modal states (permission/menu/resume/dismiss) always win:
 *     they are a direct observation that input is blocked RIGHT NOW.
 *   - Scraped "working" is never downgraded: auto-compact relies on it to
 *     avoid sending /compact into an active pane (incl. ongoing compaction,
 *     which pushes no events), so a pushed "idle" must not override it.
 *   - Scraped idle/unknown + fresh pushed state -> pushed wins. This fixes
 *     the misclassification class where a long-running turn in a narrow
 *     pane renders no busy-regex match and gets mislabeled idle (-> false
 *     "maybe dropped" in done, auto-compact firing into it).
 *
 * Returns { status, source } where source is "tmux" or "hook".
 */
export function mergeStatus(scraped, pushed, { now = Date.now(), freshMs = 15 * 60 * 1000 } = {}) {
  const fromTmux = { status: scraped, source: "tmux" };
  const blocking = ["permission", "menu", "resume", "dismiss"];
  if (blocking.includes(scraped) || scraped === "working") return fromTmux;
  if (!pushed || now - new Date(pushed.ts).getTime() > freshMs) return fromTmux;

  const map = { working: "working", needs_you: "permission", idle: "idle" };
  const status = map[pushed.state];
  return status ? { status, source: "hook" } : fromTmux;
}

export function latestPaneStates({ since = null, path = eventsPath(),
                                   now = Date.now(), maxAgeMs = 6 * 3600 * 1000 } = {}) {
  const states = new Map();
  const toState = { prompt: "working", stop: "idle", notification: "needs_you", session_start: "idle" };
  for (const evt of readEvents({ since, path })) {
    const state = toState[evt.event];
    if (!state) continue;
    const age = now - new Date(evt.ts).getTime();
    if (age > maxAgeMs) continue;
    states.set(`${evt.session}:${evt.pane}`, { state, ts: evt.ts, detail: evt.detail || "" });
  }
  return states;
}

// `amux done` resolves ~40 pane statuses in parallel; without a memo each
// one would re-read and re-parse the same ledger file. 2s TTL: fresh enough
// for interactive use, one read per CLI invocation in practice.
let statesCache = { at: 0, states: null };

export function latestPaneStatesCached({ ttlMs = 2000 } = {}) {
  const now = Date.now();
  if (!statesCache.states || now - statesCache.at > ttlMs) {
    let states;
    try {
      states = latestPaneStates({ now });
    } catch {
      states = new Map(); // unreadable ledger must never break status reads
    }
    statesCache = { at: now, states };
  }
  return statesCache.states;
}
