// Parks a pane before its account stops it: when the stop will outlast the prompt
// cache, the pane compacts at its next turn end, so the restart after the reset
// reads a small context instead of a cold, huge one. lsrc:0 2026-10-19 on
// Mattias's wish, from references/claude-subagent-cache-2026-10-10.md: a stop
// shorter than the cache (08:05-08:20Z that day, 0 expired rewrites) is left alone,
// since a compaction would cost more than it saves and take the pane's memory.

import { unwrapPastedContent } from "./claude-prompt-text.mjs";

/** WHAT: Names the request origin a parked pane's self-compact carries. WHY: Keeps quota recovery's move waiting for its compact. */
export const QUOTA_PARK_ORIGIN = "quota-park";

// lsrc:0 2026-10-19: an account's week is used until about 3 % is left; the rest is for a clean stop, the compact
// and the handover. Parking at 4 % stopped panes too early. The floor and the park use this one number.
/** WHAT: Defines the default percent left on the week at which work stops. WHY: Keeps the floor and the park on one number. */
export const QUOTA_FLOOR_DEFAULT_PERCENT = 3;

/**
 * WHAT: Reads AMUX_QUOTA_FLOOR_PERCENT, the percent left on the week where new work stops; 0 turns it off.
 * WHY: Keeps the floor an operator setting; a bad value is reported, never silently trusted.
 */
export function quotaFloorPercent(env = process.env, warn = console.warn) {
  const raw = env.AMUX_QUOTA_FLOOR_PERCENT;
  if (raw === undefined || String(raw).trim() === "") return QUOTA_FLOOR_DEFAULT_PERCENT;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 0 && value <= 100) return value;
  warn(`AMUX_QUOTA_FLOOR_PERCENT=${raw} is not a percent from 0 to 100; using ${QUOTA_FLOOR_DEFAULT_PERCENT}`);
  return QUOTA_FLOOR_DEFAULT_PERCENT;
}

/** WHAT: Defines how near a limit counts and how long a stop must outlast each engine's cache. WHY: Keeps a short stop on its warm cache. */
export const QUOTA_PARK_POLICY = Object.freeze({
  leftPercent: QUOTA_FLOOR_DEFAULT_PERCENT,
  // Claude's cache lives 60 minutes and Codex's about 30.
  outlastMs: Object.freeze({ claude: 50 * 60_000, codex: 25 * 60_000 }),
  // How long a pending park compact may hold quota recovery's move of a stopped pane.
  moveWaitMs: 10 * 60_000,
  // 2026-10-20: the park at 3 % came 11 s before Claude S's session stopped its panes, and a reading can be ten
  // minutes old. A window forecast to stop a pane within this lead parks it too, so its turn and compact still fit.
  leadMs: 20 * 60_000,
  windowMs: Object.freeze({ session: 5 * 3_600_000, week: 7 * 86_400_000 }),
});

const KIND = { session: "session", weekly_all: "week" };

/**
 * WHAT: Returns the account's windows that can stop its panes: kind, used percent and reset.
 * WHY: Keeps a model-scoped week, which stops only that model, out of the decision.
 */
export function accountWindows(account) {
  if (!account?.ok || !Array.isArray(account.limits)) return [];
  if (account.provider === "codex") {
    const windows = (account.limits.find((limit) => limit.limitId === "codex") || account.limits[0])?.windows || [];
    return windows.filter((window) => [300, 10_080].includes(window.windowMinutes))
      .map((window) => ({ kind: window.windowMinutes === 300 ? "session" : "week", usedPercent: window.usedPercent, resetsAt: window.resetsAt }));
  }
  return account.limits.filter((limit) => KIND[limit.kind])
    .map((limit) => ({ kind: KIND[limit.kind], usedPercent: limit.usedPercent, resetsAt: limit.resetsAt }));
}

/**
 * WHAT: Returns when a window runs out at its average pace, or Infinity when it resets first.
 * WHY: Keeps a fast window from stopping panes before any reading shows its last 3 %.
 */
export function predictedStopAt(window, now, policy = QUOTA_PARK_POLICY) {
  if (window.usedPercent >= 100) return now;
  const resetsAt = Date.parse(window.resetsAt);
  const elapsed = now - (resetsAt - policy.windowMs[window.kind]);
  // The first minutes of a window say too little about its pace.
  if (!(elapsed >= policy.leadMs) || !(window.usedPercent > 0)) return Infinity;
  const stopAt = now + (100 - window.usedPercent) * (elapsed / window.usedPercent);
  // lsrc:2 was parked at 21:03:20Z on 2026-10-20 for a session forecast to run out at 21:22Z; it reset at 21:10Z.
  return stopAt < resetsAt ? stopAt : Infinity;
}

/** WHAT: Checks whether a window reset after a moment. WHY: Keeps a note read before a reset from describing the new window. */
function resetSince(window, at, now, policy) {
  // A window in use has a reset; Claude names none for one unused since it reset (Claude S read at 16:10:01Z on 2026-10-20).
  if (window.resetsAt == null) return true;
  const resetsAt = Date.parse(window.resetsAt);
  // A reading taken before the reset still shows the old window (the 16:01:37Z reading, used at 16:10:04Z).
  return resetsAt <= now ? resetsAt > at : resetsAt - policy.windowMs[window.kind] > at;
}

/**
 * WHAT: Checks whether a pane's account is about to stop it for longer than its cache lives.
 * WHY: Keeps compaction to stops that end in a cold read; Claude's grace note means the stop is here.
 */
export function quotaParkDecision({ engine, windows = [], graceNote = false, graceNoteAt = NaN, working = true, lastActivityAt = NaN, now },
  policy = QUOTA_PARK_POLICY) {
  const outlastMs = policy.outlastMs[engine];
  if (!outlastMs) return { park: false, cell: "engine" };
  const live = windows.filter((window) => Number.isFinite(window.usedPercent) && Date.parse(window.resetsAt) > now);
  const spent = live.some((window) => window.usedPercent >= 100);
  // A note read before a window reset belongs to a stop that is over (skybar:1 at 11:10:11Z, eight panes at 16:10Z on
  // 2026-10-20). A spent window keeps the note: a spent week stops the pane past its session's reset.
  const note = graceNote && (spent || !(Number.isFinite(graceNoteAt)
    && windows.some((window) => Number.isFinite(window.usedPercent) && resetSince(window, graceNoteAt, now, policy))));
  // A spent window has stopped the pane already and its account refuses the compact; within Claude's grace it still runs.
  if (!note && spent) return { park: false, cell: "already-stopped" };
  const atFloor = (window) => 100 - window.usedPercent <= policy.leftPercent;
  const near = live.filter((window) => atFloor(window) || predictedStopAt(window, now, policy) - now <= policy.leadMs);
  // At the grace note a fresh reading may not show the window full yet; the fullest one is stopping the pane.
  const stopping = near.length ? near : note ? live.toSorted((left, right) => right.usedPercent - left.usedPercent).slice(0, 1) : [];
  if (!stopping.length) return { park: false, cell: note ? "reset-unknown" : "room" };
  // The pane runs again only when every stopping window has reset.
  const last = stopping.reduce((latest, window) => (Date.parse(window.resetsAt) > Date.parse(latest.resetsAt) ? window : latest));
  const resetAt = Date.parse(last.resetsAt);
  // A window at the floor, or the grace note, stops the pane now; one forecast to run out, at its forecast.
  const stopAt = Math.max(now, Math.min(...stopping.map((window) => (atFloor(window) || !near.length ? now : predictedStopAt(window, now, policy)))));
  // A working pane keeps its cache warm until the stop; an idle one's cache has aged since its last activity.
  const cacheFrom = working || !Number.isFinite(lastActivityAt) ? stopAt : lastActivityAt;
  if (resetAt - cacheFrom <= outlastMs) return { park: false, cell: "cache-outlives-stop", window: last.kind, resetAt };
  return { park: true, cell: near.length ? "near-limit" : "grace-note", window: last.kind, resetAt, leftPercent: Math.max(0, 100 - last.usedPercent) };
}

/**
 * WHAT: Reads AMUX_CODEX_CREDITS: hold (default) keeps Codex work off paid credits; allow lets it draw them.
 * WHY: Keeps credits unused until he allows them; a bad value is reported and holds.
 */
export function codexCreditsAllowed(env = process.env, warn = console.warn) {
  const raw = String(env.AMUX_CODEX_CREDITS ?? "").trim();
  if (raw === "allow") return true;
  if (raw !== "" && raw !== "hold") warn(`AMUX_CODEX_CREDITS=${raw} is not hold or allow; holding`);
  return false;
}

// lsrc:0 2026-10-20 ~18:0xZ: Codex A's 5 h window read 100 % from about 17:35Z and its panes worked on, drawing paid
// credits (375.96 SEK per 1 000, about 1 200 an hour). Codex refuses nothing while credits last, so no stop showed.
/**
 * WHAT: Returns a Codex account's spent window with the latest reset, unless credits are allowed, or null.
 * WHY: Keeps automatic turns off paid credits until every spent window has reset.
 */
export function codexCreditHold({ windows = [], provider = null, creditsAllowed = false, now }) {
  if (provider !== "codex" || creditsAllowed) return null;
  const spent = windows.filter((window) => window.usedPercent >= 100 && Date.parse(window.resetsAt) > now)
    .sort((left, right) => Date.parse(right.resetsAt) - Date.parse(left.resetsAt))[0];
  return spent ? { leftPercent: 0, resetsAt: spent.resetsAt, window: spent.kind, credits: true } : null;
}

/**
 * WHAT: Returns what holds automatic work: a spent Codex window, or the week at the floor.
 * WHY: Keeps new automatic work off an account about to stop, or off paid credits.
 */
export function quotaFloorHold({ windows = [], floorPercent = QUOTA_FLOOR_DEFAULT_PERCENT, now, provider = null, creditsAllowed = false }) {
  const credits = codexCreditHold({ windows, provider, creditsAllowed, now });
  if (credits) return credits;
  if (!(floorPercent > 0)) return null;
  const week = windows.find((window) => window.kind === "week" && Number.isFinite(window.usedPercent)
    && Date.parse(window.resetsAt) > now);
  if (!week || 100 - week.usedPercent > floorPercent) return null;
  return { leftPercent: Math.max(0, 100 - week.usedPercent), resetsAt: week.resetsAt };
}

/** WHAT: Checks whether a pane's pending self-request is a park young enough to hold a move. WHY: Keeps a compact that cannot run from holding a stopped pane. */
export const parkHoldsMove = (request, now, policy = QUOTA_PARK_POLICY) =>
  request?.origin === QUOTA_PARK_ORIGIN && now - Date.parse(request.requestedAt) < policy.moveWaitMs;

/** WHAT: Names the first line of every park handoff. WHY: Keeps the handoff itself from counting as a pane's new turn. */
export const QUOTA_PARK_HEADER = "[AMUX QUOTA PARK · SAME SESSION]";

/** WHAT: Formats the handoff a parked pane continues from after its compact. WHY: Keeps the task going instead of starting it over. */
export function quotaParkContinuation({ window, resetAt }) {
  return `${QUOTA_PARK_HEADER}\n`
    + `Your account's ${window} window stops you until ${new Date(resetAt).toISOString().slice(0, 16).replace("T", " ")}Z,`
    + " so this session was compacted at your turn end to keep the restart after the reset small."
    + " Continue the task you were on from the compact summary. Do not repeat an external side effect that already has a receipt.";
}

// lsrc:0 2026-10-19: ten Claude S panes read "stops you until 03:59Z" and ended their turns. A free reset gave the
// account room at 20:26Z and nothing told them; two sat idle about 45 minutes until a person woke them.
/**
 * WHAT: Returns resume, wait or drop for one parked pane, with the reason in words.
 * WHY: Keeps the recovery tick and a replay of past events on one rule.
 */
export function parkResumeDecision({ park, windows = null, observedAt = NaN, activity = () => ({}), now, resetGraceMs = 15_000 },
  policy = QUOTA_PARK_POLICY) {
  const room = roomAfterPark({ park, windows, observedAt, now, resetGraceMs }, policy);
  if (room.action !== "resume") return room;
  // lsrc:0 2026-10-20: when room returns, a parked pane is left alone only if it is working or has a message in its
  // queue. A message it got after the park and finished does not count: claw:1 did that at 19:59Z, then sat idle.
  const { queued = null, turn = null } = activity();
  if (queued) return { action: "drop", reason: `a ${queued.source || "queued"} message waits in its queue` };
  if (!turn?.busy) return room;
  // The park notice's own turn ends in exactly the wait this resume ends. Claude records a paste in an envelope.
  if (unwrapPastedContent(String(turn.prompt ?? "")).trimStart().startsWith(QUOTA_PARK_HEADER)) {
    return { action: "wait", reason: "its park notice turn is still running" };
  }
  return { action: "drop", reason: "it is working on a later request" };
}

/** WHAT: Returns whether a parked pane's account has room again, with the reason. WHY: Separates the account's room from the pane's work. */
function roomAfterPark({ park, windows, observedAt, now, resetGraceMs }, policy) {
  const resetAt = Number(park.resetAt);
  if (now >= resetAt + resetGraceMs) {
    return { action: "resume", reason: `its ${park.window} window reset at ${new Date(resetAt).toISOString()}` };
  }
  // A reading from before the park cannot show room the park did not see.
  if (!windows || !(observedAt > Date.parse(park.parkedAt))) return { action: "wait", reason: "no reading of its account since the park" };
  const spent = windows.find((window) => window.usedPercent >= 100);
  if (spent) return { action: "wait", reason: `its ${spent.kind} window is spent` };
  const parked = windows.find((window) => window.kind === park.window);
  if (!parked) return { action: "wait", reason: `the reading has no ${park.window} window` };
  const left = 100 - parked.usedPercent;
  // A pane parked before its window ran low waits for more room than it had then, not only for the floor.
  if (left <= Math.max(policy.leftPercent, park.leftPercent ?? 0)) return { action: "wait", reason: `its ${park.window} window has ${left} % left` };
  return { action: "resume", reason: `${park.account?.name || "its account"} has ${left} % of its ${park.window} window left` };
}
