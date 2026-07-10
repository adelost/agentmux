// Event ledger: panes PUSH their own state transitions via Claude Code hooks
// (bin/amux-hook.mjs) instead of amux inferring state by scraping tmux and
// tailing session jsonl. One append-only file; readers derive per-pane state
// from the newest event. This is the root-cause fix for the
// misclassification bug class (working/idle/needs-you guessed wrong from
// terminal rendering).
//
// File format: one JSON object per line, append-only:
//   {"ts":"2026-07-08T12:00:00.000Z","event":"stop","session":"claw",
//    "pane":1,"cwd":"/…/.agents/1","sessionId":"…","detail":"","needsYou":false}
//
// Writers: the hook script (one line per turn boundary — cheap, atomic
// O_APPEND). Rotation: append() truncates to the newest slice when the file
// exceeds MAX_BYTES; best-effort and loss-tolerant (events are hints with
// short useful lifetimes, jsonl/tmux remain the deep source of truth).

import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import { parseJsonlText, readTailWindow } from "./jsonl-reader.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const KEEP_LINES_ON_ROTATE = 4000;
// Recent events live in the file's tail (append-only); readers never need
// more than this to answer "what is each pane's newest state".
const READ_TAIL_BYTES = 256 * 1024;

/** Claude Code hook_event_name -> ledger event. Unknown events are dropped. */
export const HOOK_EVENT_MAP = {
  UserPromptSubmit: "prompt",   // a turn started: pane is working
  Stop: "stop",                 // turn finished: pane is idle
  Notification: "notification", // may need the human (see needsYou below)
  SessionStart: "session_start",
};

// Single event->state vocabulary shared by every reader. A notification only
// implies needs_you when it was a real permission/approval ask (evt.needsYou);
// Claude also fires Notification for the benign "waiting for your input"
// idle-60s ping, which must NOT flag the pane red (it fires after essentially
// every unattended turn).
const STATE_BY_EVENT = {
  prompt: "working",
  stop: "idle",
  session_start: "idle",
  notification: (evt) => (evt.needsYou ? "needs_you" : null),
};

const PERMISSION_NOTIFICATION = /permission|approv|allow/i;

export function eventsPath() {
  return process.env.AMUX_EVENTS_PATH || join(homedir(), ".agentmux", "events.jsonl");
}

/**
 * Build a ledger event from a Claude Code hook payload + resolved pane.
 * Returns null for events we don't track (keeps the hook script dumb).
 *
 * Slash commands (/compact, /clear, ...) are NOT turns: they fire
 * UserPromptSubmit but often no matching Stop, which would pin the pane
 * "working" (e.g. dream's /compact then waiting for idle forever).
 */
export function buildEvent(hookPayload, paneInfo, now = new Date()) {
  const event = HOOK_EVENT_MAP[hookPayload?.hook_event_name];
  if (!event || !paneInfo?.session) return null;
  const prompt = String(hookPayload.prompt || "");
  if (event === "prompt" && prompt.trimStart().startsWith("/")) return null;

  const message = String(hookPayload.message || "");
  return {
    ts: now.toISOString(),
    event,
    session: paneInfo.session,
    pane: Number(paneInfo.pane) || 0,
    cwd: hookPayload.cwd || "",
    sessionId: hookPayload.session_id || "",
    detail: message.slice(0, 200),
    ...(event === "notification"
      ? { needsYou: PERMISSION_NOTIFICATION.test(message) }
      : {}),
    // startup/resume/compact/clear — makes "why did this pane restart at
    // 04:xx" a lookup instead of an inference (the 2026-07-10 forensics).
    ...(event === "session_start" && hookPayload.source
      ? { source: String(hookPayload.source) }
      : {}),
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
    // Unique tmp per writer (concurrent hooks at the boundary must not
    // clobber each other's half-written tmp), then rename so a concurrent
    // appender can at worst lose its own single line, never corrupt the file.
    const tmp = `${path}.rotate.${process.pid}`;
    writeFileSync(tmp, kept.join("\n") + "\n");
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort by design, but visibly so: a persistently failing rotation
    // means every future append re-reads a growing multi-MB file.
    console.error(`[amux-events] rotation failed: ${err.message}`);
  }
}

/**
 * Recent parseable events, oldest first. Reads only the file's tail
 * (append-only ledger: recent = last). Corrupt lines are skipped, not fatal.
 */
export function readEvents({ since = null, path = eventsPath(),
                             tailBytes = READ_TAIL_BYTES } = {}) {
  if (!existsSync(path)) return [];
  const cutoff = since ? new Date(since).getTime() : null;
  const text = tailBytes
    ? readTailWindow(path, tailBytes).text
    : readFileSync(path, "utf-8");
  const events = [];
  for (const evt of parseJsonlText(text)) {
    if (cutoff !== null) {
      const t = new Date(evt.ts || 0).getTime();
      // Unparseable ts must not pass a cutoff filter (NaN compares false).
      if (!Number.isFinite(t) || t < cutoff) continue;
    }
    events.push(evt);
  }
  return events;
}

/**
 * Newest pushed state per pane: Map "session:pane" -> { state, ts, detail }.
 * States per STATE_BY_EVENT: prompt->working, stop/session_start->idle,
 * permission-notification->needs_you (benign notifications carry no state).
 *
 * maxAgeMs guards against stale truth: a hook that stopped firing (pane
 * killed, hooks uninstalled) must not pin a pane's state forever. Events
 * with unparseable timestamps are treated as stale, never as fresh.
 * Older entries are omitted — callers fall back to the scraping path.
 */
export function latestPaneStates({ since = null, path = eventsPath(),
                                   now = Date.now(), maxAgeMs = 6 * 3600 * 1000 } = {}) {
  const states = new Map();
  for (const evt of readEvents({ since, path })) {
    const resolve = STATE_BY_EVENT[evt.event];
    const state = typeof resolve === "function" ? resolve(evt) : resolve;
    if (!state) continue;
    const age = now - new Date(evt.ts || 0).getTime();
    if (!Number.isFinite(age) || age > maxAgeMs) continue;
    states.set(`${evt.session}:${evt.pane}`, { state, ts: evt.ts, detail: evt.detail || "" });
  }
  return states;
}

/**
 * Merge a tmux-scraped status with a hook-pushed state. Deliberately
 * monotone-safe, expressed as an ALLOWLIST: pushed events may only refine
 * scraped "idle" or "unknown". Everything else — modals (permission/menu/
 * resume/dismiss), "working", and any status added to detectPaneStatus in
 * the future — is a live observation that always wins. auto-compact depends
 * on scraped "working" never being downgraded (an ongoing compaction pushes
 * no events).
 *
 * Freshness is per state: a pushed "working" may pin an actually-idle pane
 * when its turn ended without a Stop hook (Esc interrupt, crash), so it
 * only overrides for a short window; "idle"/"needs_you" have no such
 * failure mode and get the longer one.
 *
 * Returns { status, source } where source is "tmux" or "hook".
 */
export const WORKING_OVERRIDE_MS = 5 * 60 * 1000;
export const PUSHED_FRESH_MS = 15 * 60 * 1000;

export function mergeStatus(scraped, pushed, { now = Date.now() } = {}) {
  const fromTmux = { status: scraped, source: "tmux" };
  if (scraped !== "idle" && scraped !== "unknown") return fromTmux;
  if (!pushed) return fromTmux;

  const age = now - new Date(pushed.ts || 0).getTime();
  if (!Number.isFinite(age)) return fromTmux;

  if (pushed.state === "working") {
    return age <= WORKING_OVERRIDE_MS ? { status: "working", source: "hook" } : fromTmux;
  }
  if (age > PUSHED_FRESH_MS) return fromTmux;
  if (pushed.state === "needs_you") return { status: "permission", source: "hook" };
  if (pushed.state === "idle") return { status: "idle", source: "hook" };
  return fromTmux;
}

// `amux done` resolves ~40 pane statuses in parallel and the bridge polls
// status continuously; key the memo on the ledger file's identity
// (size+mtime) so unchanged files are never re-read and a fresh append is
// picked up immediately — no blind TTL staleness.
let statesCache = { key: "", states: null };

export function latestPaneStatesCached() {
  let key = "missing";
  try {
    const st = statSync(eventsPath());
    key = `${st.size}:${st.mtimeMs}`;
  } catch {
    // no ledger file yet: cache the empty result under "missing"
  }
  if (!statesCache.states || statesCache.key !== key) {
    let states;
    try {
      states = latestPaneStates({ now: Date.now() });
    } catch (err) {
      // Scrape-fallback is by design, but the degradation must be visible.
      console.error(`[amux-events] ledger read failed, statuses fall back to scraping: ${err.message}`);
      states = new Map();
    }
    statesCache = { key, states };
  }
  return statesCache.states;
}
