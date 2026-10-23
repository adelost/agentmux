// An hourly meta-review for leader panes, carried by the pane's next natural
// turn: Claude's UserPromptSubmit hook, or the next real delivery to another
// engine. Nothing here sends a message or runs on a timer, so an idle leader
// is never woken for it.
//
// Mattias 2026-10-11 ~05:0xZ: "Det finns ju en reminder i amux så det är nästan
// som att man där borde ha haft att en påminnelse om att optimera planen" and
// "vi vill inte liksom introducera för mycket som har funkat dåligt eller bara
// inte gjort någon effekt eller bara tagit tid". skyvw:0's hourly reviews that
// night improved 2 of 5 cases; its 30-minute rounds changed nothing in about 10.

import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { leaderPanes } from "./pause-compact.mjs";

export const LEADER_REVIEW_INTERVAL_MS = 60 * 60_000;
// It opens with the last change's effect: of skyvw:0's 14 reviews on
// 2026-10-10/11, 3 of 9 improvements were checked afterwards (Mattias:
// "metagranskar vad de metagranskar"). No action is a valid outcome: "made now"
// pulled leaders toward a new action every hour (Mattias, 2026-10-23, delivery 74d1733e).
/** WHAT: Defines the one review text. WHY: Keeps the review from becoming an hourly mandate for new work. */
export const LEADER_REVIEW_TEXT = "[amux leader review] About an hour since your last review. At the next natural checkpoint, "
  + "in at most five lines: whether the last review's change helped: keep, adjust or drop, with its evidence; "
  + "what was delivered since then, with numbers and start and end points; what stands still and why; "
  + "at most one small correction for a measured problem; otherwise say 'keep, no action'. "
  + "This reminder creates no new task or rewrite mandate.";
// "dry" logs when a review would be added and adds nothing; "on" adds it.
export const LEADER_REVIEW_MODE = "on";

const STATE_PATH = join(homedir(), ".agentmux", "leader-review.json");
const LOG_PATH = join(homedir(), ".agentmux", "leader-review.jsonl");

/**
 * WHAT: Decides whether a pane's natural turn carries the review now.
 * WHY: Keeps builders out and the first sighting of a leader from reviewing at once.
 */
export function leaderReviewDue({ leader, lastAtMs, nowMs, intervalMs = LEADER_REVIEW_INTERVAL_MS }) {
  if (!leader) return { due: false, reason: "not a leader" };
  if (!Number.isFinite(lastAtMs)) return { due: false, reason: "first turn seen; the hour starts now", start: true };
  const ageMs = nowMs - lastAtMs;
  return ageMs >= intervalMs ? { due: true, reason: `${Math.round(ageMs / 60_000)} min since the last review` }
    : { due: false, reason: `${Math.round(ageMs / 60_000)} min since the last review` };
}

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return {}; throw error; }
};

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

/**
 * WHAT: Builds the review step both turn paths share. take(paneKey) returns the text to add to this turn, or null.
 * WHY: Keeps one clock per pane whichever engine or path carries the turn.
 */
export function createLeaderReview({ isLeader, mode = LEADER_REVIEW_MODE, now = Date.now,
  statePath = STATE_PATH, record = (line) => { mkdirSync(dirname(LOG_PATH), { recursive: true }); appendFileSync(LOG_PATH, `${JSON.stringify(line)}\n`); } }) {
  function take(paneKey, path) {
    if (mode === "off") return null;
    const [name, pane] = [paneKey.slice(0, paneKey.lastIndexOf(":")), Number(paneKey.slice(paneKey.lastIndexOf(":") + 1))];
    const state = readJson(statePath);
    const nowMs = now();
    const decision = leaderReviewDue({ leader: isLeader(name, pane), lastAtMs: state[paneKey]?.lastAtMs, nowMs });
    if (!decision.due && !decision.start) return null;
    // A dry run advances the same clock, so its log shows the hourly cadence a live run would have.
    writeJson(statePath, { ...state, [paneKey]: { lastAtMs: nowMs } });
    const outcome = decision.start ? "clock-started" : mode === "on" ? "added" : "would-add";
    try { record({ at: new Date(nowMs).toISOString(), pane: paneKey, mode, path, outcome, reason: decision.reason }); } catch { /* the log is evidence, not control */ }
    return outcome === "added" ? LEADER_REVIEW_TEXT : null;
  }
  return { take };
}

/** WHAT: Reads leader panes from the runtime agent config. WHY: Keeps the hook and the bridge on the same leader definition. */
export function leaderFromConfig(listAgents, configPath) {
  return (name, pane) => leaderPanes(listAgents(configPath).find((agent) => agent.name === name)).has(pane);
}
