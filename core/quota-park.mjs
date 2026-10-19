// Parks a pane before its account stops it: when the stop will outlast the prompt
// cache, the pane compacts at its next turn end, so the restart after the reset
// reads a small context instead of a cold, huge one. lsrc:0 2026-10-19 on
// Mattias's wish, from references/claude-subagent-cache-2026-10-10.md: a stop
// shorter than the cache (08:05-08:20Z that day, 0 expired rewrites) is left alone,
// since a compaction would cost more than it saves and take the pane's memory.

/** WHAT: Names the request origin a parked pane's self-compact carries. WHY: Keeps quota recovery's move waiting for its compact. */
export const QUOTA_PARK_ORIGIN = "quota-park";

/** WHAT: Defines how near a limit counts and how long a stop must outlast each engine's cache. WHY: Keeps a short stop on its warm cache. */
export const QUOTA_PARK_POLICY = Object.freeze({
  leftPercent: 4,
  // Claude's cache lives 60 minutes and Codex's about 30.
  outlastMs: Object.freeze({ claude: 50 * 60_000, codex: 25 * 60_000 }),
  // How long a pending park compact may hold quota recovery's move of a stopped pane.
  moveWaitMs: 10 * 60_000,
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
 * WHAT: Checks whether a pane's account is about to stop it for longer than its cache lives.
 * WHY: Keeps compaction to stops that end in a cold read; Claude's grace note means the stop is here.
 */
export function quotaParkDecision({ engine, windows = [], graceNote = false, now }, policy = QUOTA_PARK_POLICY) {
  const outlastMs = policy.outlastMs[engine];
  if (!outlastMs) return { park: false, cell: "engine" };
  const live = windows.filter((window) => Number.isFinite(window.usedPercent) && Date.parse(window.resetsAt) > now);
  // A spent window has stopped the pane already and its account refuses the compact; within Claude's grace it still runs.
  if (!graceNote && live.some((window) => window.usedPercent >= 100)) return { park: false, cell: "already-stopped" };
  const near = live.filter((window) => 100 - window.usedPercent <= policy.leftPercent);
  // At the grace note a fresh reading may not show the window full yet; the fullest one is stopping the pane.
  const stopping = near.length ? near : graceNote ? live.toSorted((left, right) => right.usedPercent - left.usedPercent).slice(0, 1) : [];
  if (!stopping.length) return { park: false, cell: graceNote ? "reset-unknown" : "room" };
  // The pane runs again only when every stopping window has reset.
  const last = stopping.reduce((latest, window) => (Date.parse(window.resetsAt) > Date.parse(latest.resetsAt) ? window : latest));
  const resetAt = Date.parse(last.resetsAt);
  if (resetAt - now <= outlastMs) return { park: false, cell: "cache-outlives-stop", window: last.kind, resetAt };
  return { park: true, cell: near.length ? "near-limit" : "grace-note", window: last.kind, resetAt };
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
export function parkResumeDecision({ park, windows = null, observedAt = NaN, newTurn = null, now, resetGraceMs = 15_000 },
  policy = QUOTA_PARK_POLICY) {
  if (newTurn) return { action: "drop", reason: newTurn };
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
  if (left <= policy.leftPercent) return { action: "wait", reason: `its ${park.window} window has ${left} % left` };
  return { action: "resume", reason: `${park.account?.name || "its account"} has ${left} % of its ${park.window} window left` };
}
