// Weekly Claude quota warning for the accounts panes actually run on.
//
// It reads through the shared five-minute budget, forecasts from readings
// already stored there, and tells Mattias once per account and weekly window,
// with one stronger notice when the limit is hours away. It never switches.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatWeeklyNotice, weeklyForecast, weeklyNoticeLevel } from "../core/quota-forecast.mjs";

const positiveNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/** WHAT: Reads the warning settings. WHY: Keeps the threshold an operator setting while its meaning is open (default 80 % weekly used). */
export function parseQuotaWarningConfig(env = process.env) {
  return {
    enabled: env.AMUX_QUOTA_WARNING_ENABLED !== "false",
    warnPercent: Math.min(100, positiveNumber(env.AMUX_QUOTA_WARN_PERCENT, 80)),
    urgentHours: positiveNumber(env.AMUX_QUOTA_WARN_URGENT_HOURS, 12),
    pollMs: Math.max(5 * 60_000, positiveNumber(env.AMUX_QUOTA_WARN_POLL_MS, 15 * 60_000)),
  };
}

const weeklyOf = (result) => result?.ok === true
  ? result.limits?.find((limit) => limit?.kind === "weekly_all") || null : null;

/** WHAT: Names one account's weekly window. WHY: Keeps "once per window" stable across reset-time drift. */
export const weeklyWindowKey = (email, resetsAt) => `${createHash("sha256")
  .update(String(email).toLowerCase()).digest("hex").slice(0, 16)}:${Math.round(Date.parse(resetsAt) / 3_600_000)}`;

/** WHAT: Stores which notices each account window has had. WHY: Keeps a bridge restart from repeating a notice. */
export function createSentNoticeStore(path = join(resolve(process.env.HOME || homedir()), ".agentmux", "quota-warning-sent.json")) {
  const read = () => {
    try { return JSON.parse(readFileSync(path, "utf8")) || {}; }
    catch { return {}; }
  };
  return {
    levels: (key) => read()[key]?.levels || [],
    record(key, levels, { now, resetAt }) {
      const current = read();
      // A window is never asked about again a day after its reset.
      for (const [stored, value] of Object.entries(current)) {
        if (!(Number(value?.expiresAt) >= now)) delete current[stored];
      }
      current[key] = { levels: [...new Set([...(current[key]?.levels || []), ...levels])],
        expiresAt: (Number.isFinite(resetAt) ? resetAt : now) + 24 * 3_600_000 };
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(current), { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}

/** WHAT: Collects each Claude account once by email, from the given profiles. WHY: Keeps two slots on one login from being read or warned about twice. */
export function claudeAccountsOf(profiles, identityOf) {
  const accounts = new Map();
  for (const profile of profiles) {
    const email = identityOf(profile)?.email?.toLowerCase();
    if (profile?.provider === "claude" && email && !accounts.has(email)) accounts.set(email, { email, profile });
  }
  return [...accounts.values()];
}

/**
 * WHAT: Checks every Claude account a pane runs on and sends the notice its forecast deserves.
 * WHY: Keeps Mattias ahead of a weekly limit without spending usage calls or switching anything for him.
 */
export async function runQuotaWarningTick({
  accountsInUse, allAccounts, readQuota, historyOf, notify, sent, config = parseQuotaWarningConfig(), now = Date.now(),
}) {
  const notices = [];
  const readings = new Map();
  const reading = async (account) => {
    if (!readings.has(account.email)) readings.set(account.email, await readQuota(account.profile).catch(() => null));
    return readings.get(account.email);
  };
  for (const account of accountsInUse()) {
    const weekly = weeklyOf(await reading(account));
    if (!weekly?.resetsAt) continue;
    const latest = { at: now, usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt };
    const forecast = weeklyForecast({ history: historyOf(account.profile), latest, now });
    const level = weeklyNoticeLevel(forecast, { ...config, now });
    const key = weeklyWindowKey(account.email, weekly.resetsAt);
    if (!level || sent.levels(key).includes(level)) continue;
    const alternatives = [];
    for (const other of allAccounts().filter((candidate) => candidate.email !== account.email)) {
      const otherWeekly = weeklyOf(await reading(other));
      if (otherWeekly) alternatives.push({ email: other.email, usedPercent: otherWeekly.usedPercent, resetsAt: otherWeekly.resetsAt });
    }
    alternatives.sort((left, right) => left.usedPercent - right.usedPercent);
    const text = formatWeeklyNotice({ level, email: account.email, forecast, alternatives, now });
    await notify(text, { level: level === "urgent" ? "urgent" : "warn", title: "Claude-kvot",
      idempotencyKey: `claude-weekly:${key}:${level}` });
    // The stronger notice already says everything the ordinary one would.
    sent.record(key, level === "urgent" ? ["threshold", "urgent"] : [level], { now, resetAt: forecast.resetAt });
    notices.push({ email: account.email, level, text });
  }
  return notices;
}

/** WHAT: Schedules the warning tick without overlap. WHY: Keeps a slow usage read from stacking ticks in the bridge. */
export function createQuotaWarningLoop({ tick, config = parseQuotaWarningConfig(), log = (message) => console.log(`quota-warning | ${message}`),
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  let running = false, intervalId = null;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (const notice of await tick()) log(`${notice.level} sent for ${notice.email}`);
    } catch (error) {
      log(`tick failed: ${error.message}`);
    } finally {
      running = false;
    }
  };
  return {
    start() {
      if (intervalId || !config.enabled) return;
      intervalId = setIntervalImpl(run, config.pollMs);
      intervalId?.unref?.();
      void run();
    },
    stop() {
      if (intervalId) clearIntervalImpl(intervalId);
      intervalId = null;
    },
    run,
  };
}
