// Tells the dispatcher when a pane stays unable to work while an account of its engine has room.
// 2026-10-18: skyvw:0 sat 10.7 h on a spent account, 5.8 h of them while Claude S had its
// whole week free, and nothing told anyone. The alarm only reports: it never wakes,
// moves or restarts a pane.

import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { isQuotaParkedJob } from "./claude-quota-coordinator.mjs";
import { isLiveStatus } from "./pane-status.mjs";

/** WHAT: Names the durable per-pane episode record. WHY: Keeps one notice per pane and episode across bridge restarts. */
export const IDLE_CAPACITY_STATE_KEY = "idle_capacity_alarm_v1";
/** WHAT: Names how long a pane may stay unable to work before the dispatcher hears of it. WHY: Shorter stops recover by themselves. */
export const IDLE_CAPACITY_AFTER_MS = 15 * 60_000;

const isHeldByLimit = (job) => isQuotaParkedJob(job) || /codex-weekly-limit|quota-floor/u.test(String(job.lastReason || ""));
const oldestOf = (jobs) => jobs.reduce((oldest, job) => (!oldest || job.createdAt < oldest.createdAt ? job : oldest), null);

function stopEvidence({ limitReceipt, jobs, processStopped, park }) {
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
  // A pane the quota park stopped has no receipt and an empty queue; only its park record shows the stop.
  // It counts once the park notice reached the pane: before that the pane was never told to stop.
  if (park?.state === "parked" && park.noticeJobId && !live.length) {
    return { episode: `park:${park.parkedAt}`, since: Date.parse(park.parkedAt), waiting: 0,
      reason: `parked by the quota park until its ${park.window} window has room` };
  }
  if (processStopped && live.length) {
    const oldest = oldestOf(live);
    return { episode: `stopped:${oldest.id}`, since: oldest.createdAt, waiting: live.length,
      reason: "its process is stopped" };
  }
  return null;
}

// The recovery prompts that belong to a stop are the ones queued at or after its start; an older one is another stop's.
const recoveryJobsSince = (history, since) => history
  .filter((job) => job.source === "quota-recovery" && (since === null || job.createdAt >= since));

/**
 * `paneStatus` is what tmux shows now. A pane that works or thinks is not stuck, whatever an old receipt or park record
 * still says (lsrc:0, 2026-10-20 11:15Z). `history` is the pane's delivery jobs; a stop whose recovery prompt was
 * acknowledged comes back with `closed: true`, and the alarm never reports it.
 * WHAT: Names why one pane cannot work and since when, or null when nothing holds it.
 * WHY: Keeps a dormant pane with an empty queue, and a pane that works now, out of the alarm.
 */
export function idlePaneEvidence({ limitReceipt = null, jobs = [], processStopped = false, park = null, paneStatus = "unknown", history = [] } = {}) {
  if (isLiveStatus(paneStatus)) return null;
  const evidence = stopEvidence({ limitReceipt, jobs, processStopped, park });
  if (!evidence) return null;
  return recoveryJobsSince(history, evidence.since).some((job) => job.status === "acknowledged") ? { ...evidence, closed: true } : evidence;
}

const duration = (ms) => {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
};

/**
 * `since` is the start of the stop being reported: only a park and recovery prompts from then on belong to it, so a
 * receipt from an earlier stop is never named (lsrc:0, 2026-10-20 11:16Z, skyvw:1 and skyvw:2).
 * WHAT: Describes what amux did to resume one pane: its park record, else its newest recovery prompt.
 * WHY: Keeps a notice about a pane on an account with room from suggesting a rotate that changes nothing.
 */
export function resumeStatus({ park = null, history = [], since = null } = {}) {
  const thisStop = park && (since === null || Date.parse(park.parkedAt) >= since) ? park : null;
  if (thisStop?.state === "resumed") return `amux sent it the same-session recovery prompt at ${thisStop.resumedAt} (${thisStop.reason}).`;
  if (thisStop?.state === "dropped") return `amux did not resume it after its quota park: ${thisStop.reason}.`;
  if (thisStop?.state === "parked") return `amux has not resumed it yet; its quota park of ${thisStop.parkedAt} is still open.`;
  const recovery = recoveryJobsSince(history, since)
    .reduce((newest, job) => (!newest || job.createdAt > newest.createdAt ? job : newest), null);
  if (!recovery) return "amux has no resume for this stop yet.";
  if (recovery.status === "acknowledged") return `amux's recovery prompt reached it at ${new Date(recovery.acknowledgedAt).toISOString()}.`;
  return `amux's recovery prompt is ${recovery.status}: ${recovery.lastReason || "no reason given"}.`;
}

/** WHAT: Formats one notice for the dispatcher. WHY: Keeps the pane, its stop, the room and the next step in one message. */
export function idleCapacityNotice({ key, engine, evidence, room, now, own = null }) {
  const waiting = evidence.waiting ? `, ${evidence.waiting} message(s) waiting` : "";
  const stuck = `[idle-capacity] ${key} has not been able to work for ${duration(now - evidence.since)}: ${evidence.reason}${waiting}. `;
  // The pane already runs on the account with room, so a rotate there would change nothing.
  if (own?.profileKey && room.profileKeys?.includes(own.profileKey)) {
    return `${stuck}${room.name}, the account it is on, has room (${room.usedPercent} % of the week used), so a rotate would change nothing. `
      + `${own.resume || resumeStatus()} One notice per pane and episode.`;
  }
  const move = engine === "codex"
    ? `\`//switch ${room.profileId}\` in ${key}'s channel`
    : `\`amux accounts rotate claude:${room.profileId}\``;
  return `${stuck}${room.name} has room (${room.usedPercent} % of the week used). `
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
      const observation = await observe(pane);
      const evidence = idlePaneEvidence(observation);
      if (!evidence) continue;
      // The recovery prompt reached the pane, so this stop is over. It stays on record as closed, through the pane working
      // and stopping again, and is never reported.
      if (evidence.closed) {
        sent[pane.key] = { episode: evidence.episode, at: sent[pane.key]?.episode === evidence.episode ? sent[pane.key].at : now(), closed: true };
        continue;
      }
      if (!(now() - evidence.since >= afterMs)) continue;
      stuck.add(pane.key);
      if (sent[pane.key]?.episode === evidence.episode) continue;
      if (!rooms.has(pane.engine)) rooms.set(pane.engine, await roomFor(pane.engine));
      const room = rooms.get(pane.engine);
      if (!room) continue;
      const resume = observation.resume ?? resumeStatus({ park: observation.park, history: observation.history, since: evidence.since });
      await notify(idleCapacityNotice({ key: pane.key, engine: pane.engine, evidence, room, now: now(), own: { ...observation, resume } }),
        `idle-capacity:${pane.key}:${evidence.episode}`);
      sent[pane.key] = { episode: evidence.episode, at: now() };
      log(`${pane.key} reported to ${target}: ${evidence.reason}`);
    }
    // A pane that works again is reported again when it next stops; a closed stop stays closed.
    for (const key of Object.keys(sent)) if (!stuck.has(key) && !sent[key].closed) delete sent[key];
    if (JSON.stringify(sent) !== JSON.stringify(before)) state.set(IDLE_CAPACITY_STATE_KEY, sent);
    return [...stuck];
  }

  return { tick };
}
