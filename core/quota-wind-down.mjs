import { accountWithRoom } from "./account-room.mjs";
import { accountWindows, predictedStopAt, QUOTA_PARK_POLICY } from "./quota-park.mjs";

/** WHAT: Names wind-down compact requests. WHY: Separates them from park continuations and operator requests. */
export const QUOTA_WIND_DOWN_ORIGIN = "quota-wind-down";
const MAX_AGE_MS = 10 * 60_000;
const millis = value => typeof value === "number" ? value : Date.parse(value);

/** WHAT: Reads the wind-down switch. WHY: Keeps every reader dry until a live stop's dry lines are read (design §11). */
export function readWindDownMode(env = process.env) {
  const mode = env.AMUX_QUOTA_WIND_DOWN || "dry";
  if (!["off", "dry", "on"].includes(mode)) throw new Error("AMUX_QUOTA_WIND_DOWN must be off, dry or on");
  return mode;
}

/** WHAT: Returns whether wind-down may move a pane. WHY: Keeps both engines' move paths behind the same two switches. */
export const windDownMovesEnabled = (env = process.env) => readWindDownMode(env) === "on" && env.AMUX_QUOTA_WIND_DOWN_MOVE !== "false";

/** WHAT: Returns the nearest window's forecast stage at its own pace. WHY: Prevents five-minute readings from delaying a 5 % notice. */
export function windDownStage({ windows = [], now, observedAt }) {
  const live = windows.flatMap(window => {
    const readAt = millis(window.observedAt ?? observedAt), resetAt = Date.parse(window.resetsAt);
    if (!(readAt <= now && now - readAt <= MAX_AGE_MS && resetAt > now)
        || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100) return [];
    const stopAt = predictedStopAt(window, readAt);
    if (!Number.isFinite(stopAt)) return [];
    const elapsed = readAt - (resetAt - QUOTA_PARK_POLICY.windowMs[window.kind]);
    const leftPercent = Math.max(0, 100 - window.usedPercent - window.usedPercent / elapsed * (now - readAt));
    const noticeAt = readAt - elapsed + 95 * elapsed / window.usedPercent;
    return [{ window: window.kind, resetAt, stopAt, leftPercent, noticeAt }];
  }).sort((left, right) => left.stopAt - right.stopAt);
  const nearest = live[0];
  if (!nearest || nearest.leftPercent > 5) return null;
  return { ...nearest, stage: nearest.leftPercent <= 3 ? "nudge" : "notice" };
}

/** WHAT: Returns whether a compact saves a cold read. WHY: Keeps a short stop without a move on its warm context. */
export function compactPays({ engine, resetAt, stopAt, lastActivityAt, working, target }) {
  if (!QUOTA_PARK_POLICY.outlastMs[engine]) return false;
  if (target) return true;
  return resetAt - (working ? stopAt : lastActivityAt) > QUOTA_PARK_POLICY.outlastMs[engine];
}

/** WHAT: Reads when the provider observed an account. WHY: Prevents cache refresh time from counting as fresh quota evidence. */
export function quotaObservedAt(account) {
  return millis(account?.observation?.observedAt ?? account?.fetchedAt ?? account?.limits?.find(limit => limit.limitId === "codex")?.capturedAt);
}

/** WHAT: Returns fresh room in both windows, using the alarm's ordering. WHY: Prevents a moved session from stopping again on its target. */
export function moveTarget({ engine, accounts = [], from, readAfter, reservePercent = 90, sessionFloor = 20 }) {
  const fromKey = typeof from === "string" ? from : from?.key;
  const candidates = accounts.filter(account => {
    const keys = [account.profile?.key, ...(account.sharedBy || []).map(member => member.key)];
    if (keys.includes(fromKey) || account.name === fromKey || (from?.email && account.account?.email === from.email)
        || !(quotaObservedAt(account) > readAfter)) return false;
    const windows = accountWindows(account);
    return ["week", "session"].every(kind => windows.some(window => window.kind === kind
      && Number.isFinite(window.usedPercent) && window.usedPercent >= 0
      // Claude names no reset for a window unused since it reset (Claude S at 16:10:01Z on 2026-10-20): it has room.
      && (Date.parse(window.resetsAt) > quotaObservedAt(account) || (window.resetsAt == null && window.usedPercent === 0))
      && (kind === "week" ? window.usedPercent < reservePercent : 100 - window.usedPercent >= sessionFloor)));
  });
  return accountWithRoom(candidates, engine, { reservePercent });
}

/** WHAT: Formats the two wind-down notices. WHY: Keeps every delivery on the design's same words. */
export function windDownNotice({ stage, account, leftPercent, window, resetAt }) {
  if (stage === "nudge") return `[AMUX QUOTA WIND-DOWN · 3 %] ${account} is about to stop. End your turn at the next clean boundary; amux compacts this session then.`;
  const left = Math.round(leftPercent * 10) / 10, reset = new Date(resetAt);
  // A week resets days later, so its time alone would read as today.
  const day = window === "week" ? `${reset.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} ` : "";
  return `[AMUX QUOTA WIND-DOWN · 5 %] ${account} has ${left} % of its ${window} window left (resets ${day}${reset.toISOString().slice(11, 16)}Z). Finish the current step and start no new large one; amux compacts this session when your turn ends.`;
}

/** WHAT: Formats the continuation after a verified move. WHY: Prevents repeating side effects with existing receipts. */
export function windDownContinuation({ from, to }) {
  return `[AMUX QUOTA WIND-DOWN · MOVED] This session was compacted and moved from ${from} to ${to}, which has room. Continue the task from the compact summary. Do not repeat an external side effect that already has a receipt.`;
}
