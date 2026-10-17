// Quota warnings for the human, shown in the channel he writes in and on a newly reached limit.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildQuotaOverview, weeklyQuotaOf } from "./quota-overview.mjs";

const HOUR = 3_600_000;
// Mattias 2026-10-16: "en cool down på 6 timmar på 80-90% och sen cooldown på 3 timmar på 90 till 100 %".
const WARN_COOLDOWN_MS = 6 * HOUR, RESERVE_COOLDOWN_MS = 3 * HOUR;
// The pace behind "runs out" uses the last day of readings, as weeklyForecast measures it.
const READING_SPAN_MS = 24 * HOUR;
// One overview message covers every account, so its reference is stored once.
const OVERVIEW_KEY = "overview";
const positiveNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

/** WHAT: Reads the two warning levels. WHY: Keeps the levels operator settings while the cooldowns follow Mattias's rule. */
export function parseQuotaWarningConfig(env = process.env) {
  const reservePercent = Math.min(100, positiveNumber(env.AMUX_QUOTA_RESERVE_PERCENT, 90));
  return { enabled: env.AMUX_QUOTA_WARNING_ENABLED !== "false",
    warnPercent: Math.min(reservePercent, positiveNumber(env.AMUX_QUOTA_WARN_PERCENT, 80)), reservePercent };
}

/** WHAT: Returns the wait between two warnings at one weekly usage, or null below the level. WHY: Keeps an account near its limit from waiting as long as one just past 80 %. */
export function warningCooldownMs(usedPercent, config) {
  if (!(usedPercent >= config.warnPercent)) return null;
  return usedPercent >= config.reservePercent ? RESERVE_COOLDOWN_MS : WARN_COOLDOWN_MS;
}

/** WHAT: Names one account's weekly window. WHY: Keeps restart deduplication stable across reset-time drift. */
export const weeklyWindowKey = (identity, resetsAt) => `${createHash("sha256")
  .update(String(identity).toLowerCase()).digest("hex").slice(0, 16)}:${Math.round(Date.parse(resetsAt) / HOUR)}`;

/** WHAT: Stores each account's last warning, recent readings and the overview message atomically. WHY: Keeps a bridge restart from repeating a warning or losing the pace. */
export function createSentNoticeStore(path = join(homedir(), ".agentmux", "quota-warning-sent.json")) {
  const read = () => {
    try { return JSON.parse(readFileSync(path, "utf8")) || {}; }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  };
  const update = (key, patch, { now, resetAt }) => {
    const current = read();
    for (const [stored, value] of Object.entries(current)) {
      if (!(Number(value?.expiresAt) >= now)) delete current[stored];
    }
    current[key] = { ...current[key], ...patch, expiresAt: resetAt + 24 * HOUR };
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(current), { mode: 0o600 });
    renameSync(temp, path);
  };
  return {
    entry: key => read()[key] || null,
    record(key, usedPercent, options) { update(key, { reminder: { at: options.now, usedPercent } }, options); },
    saveNotice(key, notice, options) { update(key, { notice }, options); },
    readings: key => read()[key]?.readings || [],
    observe(key, point, options) {
      const kept = (read()[key]?.readings || []).filter(earlier => earlier.at >= options.now - READING_SPAN_MS);
      if (kept.at(-1)?.at >= point.at) return;
      update(key, { readings: [...kept, point] }, options);
    },
  };
}

const identityOf = account => account.provider === "claude" ? account.account.email : `${account.provider}:${account.account.email}`;
const activePanes = account => [...new Set(account.activeInUse || [])];
const warnedAccounts = (accounts, config) => accounts.filter(account => activePanes(account).length
  && Number.isFinite(weeklyQuotaOf(account)?.usedPercent) && weeklyQuotaOf(account).usedPercent >= config.warnPercent);

/** WHAT: Saves each account's newest weekly reading and returns its recent ones. WHY: Lets "runs out" follow the current pace, not the week's average. */
function observeReadings(sent, accounts, now) {
  const readings = new Map();
  for (const account of accounts) {
    const weekly = weeklyQuotaOf(account), resetAt = Date.parse(weekly?.resetsAt);
    if (!account.account?.email || !Number.isFinite(weekly?.usedPercent) || !(resetAt > now)) continue;
    const key = weeklyWindowKey(identityOf(account), weekly.resetsAt), at = Date.parse(account.observation?.observedAt);
    // A reading without its own time cannot measure a pace; the forecast then uses the week's average.
    if (Number.isFinite(at)) sent.observe(key, { at, usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt }, { now, resetAt });
    readings.set(account, sent.readings(key));
  }
  return readings;
}

/** WHAT: Reads one warned account's warning history. WHY: Separates a first warning, a reached limit and a cooled-down reminder. */
function warningState(account, sent, config, now) {
  const weekly = weeklyQuotaOf(account), email = account.account?.email;
  const resetAt = Date.parse(weekly?.resetsAt), cooldownMs = warningCooldownMs(weekly?.usedPercent, config);
  if (!email || cooldownMs === null || !(resetAt > now)) return null;
  const key = weeklyWindowKey(identityOf(account), weekly.resetsAt), accountKey = weeklyWindowKey(identityOf(account), "1970-01-01T00:00:00Z");
  const previous = sent.entry(key)?.reminder;
  const lastAt = Math.max(previous?.at ?? -Infinity, sent.entry(accountKey)?.reminder?.at ?? -Infinity);
  return { account, panes: activePanes(account), provider: account.provider, email, usedPercent: weekly.usedPercent, key, accountKey, resetAt,
    justFull: weekly.usedPercent >= 100 && !(previous?.usedPercent >= 100), first: !previous, cooledDown: now - lastAt >= cooldownMs };
}

/**
 * WHAT: Dispatches the overview when an account first warns or fills, otherwise edits the last one.
 * WHY: Keeps one readable notice for both engines from repeating inside the cooldown or warning about idle accounts.
 */
export async function postDueQuotaWarnings({ snapshot, notify, sent, config = parseQuotaWarningConfig(), now = Date.now(), fullOnly = false, editNotice = null, channelId = null }) {
  if (!config.enabled) return [];
  const accounts = snapshot?.accounts || [];
  const readings = observeReadings(sent, accounts, now);
  const warned = warnedAccounts(accounts, config).map(account => warningState(account, sent, config, now)).filter(Boolean);
  if (!warned.length) return [];
  const { text, fingerprint } = buildQuotaOverview(snapshot, { config, now, readingsOf: account => readings.get(account) || [] });
  const existing = sent.entry(OVERVIEW_KEY)?.notice;
  const keep = { now, resetAt: Math.max(...warned.map(state => state.resetAt)) };
  // A first warning and a reached limit are news; anything else edits the overview he already has (Sky e2e815d6).
  const due = warned.filter(state => state.justFull || (!fullOnly && (state.first || (!existing?.messageId && state.cooledDown))));
  if (due.length) {
    const posted = await notify(text, due);
    const messageId = posted?.messageId || posted?.id;
    for (const state of warned) {
      sent.record(state.accountKey, state.usedPercent, { now, resetAt: state.resetAt });
      sent.record(state.key, state.usedPercent, { now, resetAt: state.resetAt });
    }
    sent.saveNotice(OVERVIEW_KEY, messageId ? { channelId: posted.channelId || channelId, messageId, fingerprint, text, updatedAt: now } : null, keep);
    return due;
  }
  if (!existing?.messageId || !editNotice) return [];
  const forecastDue = now - (existing.updatedAt ?? 0) >= HOUR && existing.text !== text;
  if (existing.fingerprint === fingerprint && !forecastDue) return [];
  try { await editNotice(existing, text); }
  catch (error) {
    if (Number(error.code) !== 10008) throw error;
    // He deleted the overview: the next one waits for the cooldown unless an account first warns or fills.
    sent.saveNotice(OVERVIEW_KEY, null, keep);
    return [];
  }
  sent.saveNotice(OVERVIEW_KEY, { ...existing, fingerprint, text, updatedAt: now }, keep);
  return warned.map(state => ({ ...state, edited: true }));
}
