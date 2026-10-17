// Quota warnings for the human, shown in the channel he writes in and on a newly reached limit.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatReset } from "../core/quota-format.mjs";
import { weeklyForecast } from "../core/quota-forecast.mjs";

const HOUR = 3_600_000;
// Mattias 2026-10-16: "en cool down på 6 timmar på 80-90% och sen cooldown på 3 timmar på 90 till 100 %".
const WARN_COOLDOWN_MS = 6 * HOUR, RESERVE_COOLDOWN_MS = 3 * HOUR;
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

/** WHAT: Stores each account's last warning atomically. WHY: Keeps a bridge restart from repeating a warning inside its cooldown. */
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
  };
}

/** WHAT: Extracts the account's weekly quota. WHY: Prevents short and scoped windows from triggering warnings. */
export function weeklyQuotaOf(account) {
  if (!account?.ok) return null;
  if (account.provider === "claude") return account.limits?.find(limit => limit.kind === "weekly_all") || null;
  if (account.provider === "codex") return (account.limits?.find(limit => limit.limitId === "codex")
    || account.limits?.[0])?.windows?.find(window => window.windowMinutes === 10080) || null;
  return null;
}

const providerName = account => ({ claude: "Claude", codex: "Codex", kimi: "Kimi" })[account.provider] || account.provider;
const emailOf = account => account.account?.email || account.profile?.label || "unknown login";
const spareAccounts = (accounts, account, config, now) => accounts.filter(other => other.provider === account.provider
  && other.account?.email && other.account.email.toLowerCase() !== emailOf(account).toLowerCase()
  && (other.provider !== "codex" || /^[12]$/u.test(String(other.profile?.id)))
  && Number.isFinite(weeklyQuotaOf(other)?.usedPercent) && Date.parse(weeklyQuotaOf(other)?.resetsAt) > now
  && weeklyQuotaOf(other).usedPercent < config.warnPercent)
  .sort((a, b) => weeklyQuotaOf(a).usedPercent - weeklyQuotaOf(b).usedPercent);

const accountName = account => `${providerName(account)} ${emailOf(account).split("@")[0].split(".").at(-1)}`;
const activePanes = account => [...new Set(account.activeInUse || [])];
const warnedAccounts = (accounts, config) => accounts.filter(account => activePanes(account).length
  && Number.isFinite(weeklyQuotaOf(account)?.usedPercent) && weeklyQuotaOf(account).usedPercent >= config.warnPercent);
const when = at => formatReset(at ? new Date(at).toISOString() : null).replace(/^reset /u, "") || "okänt";

function windowForecast(account, now) {
  const weekly = weeklyQuotaOf(account), resetAt = Date.parse(weekly?.resetsAt);
  if (!Number.isFinite(weekly?.usedPercent) || weekly.usedPercent < 0 || !(resetAt > now)) return null;
  const forecast = weeklyForecast({ latest: { usedPercent: weekly.usedPercent, resetsAt: weekly.resetsAt }, now });
  return forecast.pace ? forecast : null;
}

/** WHAT: Formats only active accounts above the warning level. WHY: Prevents quiet or spare accounts from becoming warning rows. */
export function formatQuotaWarning(snapshot, { config = parseQuotaWarningConfig(), now = Date.now(), only = null } = {}) {
  const accounts = snapshot?.accounts || [];
  return warnedAccounts(accounts, config).filter(account => !only || only.includes(account))
    .map(account => ({ account, forecast: windowForecast(account, now) }))
    .sort((a, b) => (a.forecast?.exhaustAt ?? Infinity) - (b.forecast?.exhaustAt ?? Infinity))
    .flatMap(({ account, forecast }) => {
      const weekly = weeklyQuotaOf(account), count = activePanes(account).length, full = weekly.usedPercent >= 100;
      const state = full ? "kvoten är slut" : `slut ca ${when(forecast?.exhaustAt)}`;
      const line = `${full ? "🚫" : "⚠️"} ${accountName(account)}: ${weekly.usedPercent} %, ${state}, `
        + `nollställs ${when(Date.parse(weekly.resetsAt))}, ${count} aktiv${count === 1 ? " panel" : "a paneler"}.`;
      const spare = account.provider === "claude" && !forecast?.lastsUntilReset && spareAccounts(accounts, account, config, now)[0];
      return spare ? [line, `Byt till ${accountName(spare)}: \`/byt ${emailOf(spare)}\`.`] : [line];
    }).join("\n");
}

/**
 * WHAT: Dispatches the due warnings for accounts panes run on in one message and records them.
 * WHY: Keeps the human from warnings more often than their cooldown or about accounts no pane uses.
 */
export async function postDueQuotaWarnings({ snapshot, notify, sent, config = parseQuotaWarningConfig(), now = Date.now(), fullOnly = false }) {
  if (!config.enabled) return [];
  const accounts = snapshot?.accounts || [], due = [];
  for (const account of warnedAccounts(accounts, config)) {
    const weekly = weeklyQuotaOf(account), email = account.account?.email;
    const resetAt = Date.parse(weekly?.resetsAt), cooldownMs = warningCooldownMs(weekly?.usedPercent, config);
    if (!email || cooldownMs === null || !(resetAt > now) || (fullOnly && weekly.usedPercent < 100)) continue;
    const identity = account.provider === "claude" ? email : `${account.provider}:${email}`;
    const key = weeklyWindowKey(identity, weekly.resetsAt), accountKey = weeklyWindowKey(identity, "1970-01-01T00:00:00Z");
    const lastAt = Math.max(sent.entry(key)?.reminder?.at ?? -Infinity, sent.entry(accountKey)?.reminder?.at ?? -Infinity);
    const previous = sent.entry(key)?.reminder;
    const justFull = weekly.usedPercent >= 100 && !(previous?.usedPercent >= 100);
    if (fullOnly ? !justFull : !justFull && now - lastAt < cooldownMs) continue;
    due.push({ account, panes: activePanes(account), provider: account.provider, email, usedPercent: weekly.usedPercent, key, accountKey, resetAt });
  }
  if (!due.length) return due;
  await notify(formatQuotaWarning(snapshot, { config, now, only: due.map(notice => notice.account) }), due);
  for (const notice of due) {
    sent.record(notice.accountKey, notice.usedPercent, { now, resetAt: notice.resetAt });
    sent.record(notice.key, notice.usedPercent, { now, resetAt: notice.resetAt });
  }
  return due;
}
