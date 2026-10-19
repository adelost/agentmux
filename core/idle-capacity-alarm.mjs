// Tells the dispatcher when a pane stays unable to work while an account of its engine has room.
// 2026-10-18: skyvw:0 sat 10.7 h on a spent account, 5.8 h of them while Claude S had its
// whole week free, and nothing told anyone. The alarm only reports: it never wakes,
// moves or restarts a pane.

import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { isQuotaParkedJob } from "./claude-quota-coordinator.mjs";

/** WHAT: Names the durable per-pane episode record. WHY: Keeps one notice per pane and episode across bridge restarts. */
export const IDLE_CAPACITY_STATE_KEY = "idle_capacity_alarm_v1";
/** WHAT: Names how long a pane may stay unable to work before the dispatcher hears of it. WHY: Shorter stops recover by themselves. */
export const IDLE_CAPACITY_AFTER_MS = 15 * 60_000;

const isHeldByLimit = (job) => isQuotaParkedJob(job) || String(job.lastReason || "").includes("codex-weekly-limit");
const oldestOf = (jobs) => jobs.reduce((oldest, job) => (!oldest || job.createdAt < oldest.createdAt ? job : oldest), null);

/**
 * WHAT: Names why one pane cannot take work and since when, or null when it can or nothing waits.
 * WHY: Keeps a dormant pane with an empty queue out of the alarm.
 */
export function idlePaneEvidence({ limitReceipt = null, jobs = [], processStopped = false } = {}) {
  const live = jobs.filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status));
  if (limitReceipt) {
    return { episode: `limit:${limitReceipt.limitEventId}`, since: limitReceipt.observedAt, waiting: live.length,
      reason: `stopped at its ${limitReceipt.limitKind || "usage"} limit` };
  }
  const held = live.filter(isHeldByLimit);
  if (held.length) {
    const oldest = oldestOf(held);
    return { episode: `parked:${oldest.id}`, since: oldest.createdAt, waiting: live.length,
      reason: "its messages are parked by a usage limit" };
  }
  if (processStopped && live.length) {
    const oldest = oldestOf(live);
    return { episode: `stopped:${oldest.id}`, since: oldest.createdAt, waiting: live.length,
      reason: "its process is stopped" };
  }
  return null;
}

const duration = (ms) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

/** WHAT: Words one notice for the dispatcher. WHY: Names the pane, why it is stuck, where the room is and the command that moves it. */
export function idleCapacityNotice({ key, engine, evidence, room, now }) {
  const move = engine === "codex"
    ? `\`//switch ${room.profileId}\` in ${key}'s channel`
    : `\`amux accounts rotate claude:${room.profileId}\``;
  const waiting = evidence.waiting ? `, ${evidence.waiting} message(s) waiting` : "";
  return `[idle-capacity] ${key} has not been able to work for ${duration(now - evidence.since)}: `
    + `${evidence.reason}${waiting}. ${room.name} has room (${room.usedPercent} % of the week used). `
    + `Move it with ${move}, or record why it stays. One notice per pane and episode.`;
}

/**
 * WHAT: Checks each configured Claude and Codex pane and notifies the dispatcher once per pane and episode.
 * WHY: Idle paid capacity was invisible for hours; one notice to the pane that staffs the fleet is enough.
 */
export function createIdleCapacityAlarm({
  target,
  panes,
  observe,
  roomFor,
  notify,
  state,
  now = Date.now,
  afterMs = IDLE_CAPACITY_AFTER_MS,
  log = () => {},
}) {
  if (!target || typeof panes !== "function" || typeof observe !== "function"
      || typeof roomFor !== "function" || typeof notify !== "function" || !state?.get || !state?.set) {
    throw new Error("idle capacity alarm requires target, panes, observe, roomFor, notify and state");
  }

  async function tick() {
    const before = state.get(IDLE_CAPACITY_STATE_KEY, {}) || {};
    const sent = { ...before };
    const stuck = new Set();
    const rooms = new Map();
    for (const pane of panes()) {
      // The dispatcher cannot read a notice about its own stop.
      if (pane.key === target) continue;
      const evidence = idlePaneEvidence(await observe(pane));
      if (!evidence || !(now() - evidence.since >= afterMs)) continue;
      stuck.add(pane.key);
      if (sent[pane.key]?.episode === evidence.episode) continue;
      if (!rooms.has(pane.engine)) rooms.set(pane.engine, await roomFor(pane.engine));
      const room = rooms.get(pane.engine);
      if (!room) continue;
      await notify(idleCapacityNotice({ key: pane.key, engine: pane.engine, evidence, room, now: now() }),
        `idle-capacity:${pane.key}:${evidence.episode}`);
      sent[pane.key] = { episode: evidence.episode, at: now() };
      log(`${pane.key} reported to ${target}: ${evidence.reason}`);
    }
    // A pane that works again is reported again when it next stops.
    for (const key of Object.keys(sent)) if (!stuck.has(key)) delete sent[key];
    if (JSON.stringify(sent) !== JSON.stringify(before)) state.set(IDLE_CAPACITY_STATE_KEY, sent);
    return [...stuck];
  }

  return { tick };
}
