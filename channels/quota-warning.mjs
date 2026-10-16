// Quota warnings for the human, shown in the channel he writes in.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { compactPaneList } from "../core/quota-format.mjs";

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
const loggedOut = account => !account.ok && !account.inUse?.length && [
  "login_expired", "credentials_expired", "credentials_unavailable", "login_required",
].includes(account.error);
const spareAccounts = (accounts, account, config, now) => accounts.filter(other => other.provider === account.provider
  && other.account?.email && other.account.email.toLowerCase() !== emailOf(account).toLowerCase()
  && (other.provider !== "codex" || /^[12]$/u.test(String(other.profile?.id)))
  && Number.isFinite(weeklyQuotaOf(other)?.usedPercent) && Date.parse(weeklyQuotaOf(other)?.resetsAt) > now
  && weeklyQuotaOf(other).usedPercent < config.warnPercent)
  .sort((a, b) => weeklyQuotaOf(a).usedPercent - weeklyQuotaOf(b).usedPercent);

function actionLine(accounts, config, now) {
  for (const account of [...accounts].sort((a, b) => (weeklyQuotaOf(b)?.usedPercent || 0) - (weeklyQuotaOf(a)?.usedPercent || 0))) {
    const weekly = weeklyQuotaOf(account);
    if (!account.inUse?.length || !(weekly?.usedPercent >= config.warnPercent) || !(Date.parse(weekly.resetsAt) > now)) continue;
    const best = spareAccounts(accounts, account, config, now)[0];
    if (!best) continue;
    const target = `${providerName(best)} ${best.profile.id} ${emailOf(best)} (${weeklyQuotaOf(best).usedPercent}%)`;
    const scope = "Other panes keep their accounts.";
    if (account.provider === "codex") {
      const pane = account.inUse[0];
      const state = weekly.usedPercent >= 100 ? "is full" : `is at ${weekly.usedPercent}%`;
      return `**${pane}** ${state}. Write \`//switch ${best.profile.id}\` in ${pane} to move only ${pane} to ${target}. ${scope}`;
    }
    // /byt is a fleet plan, never a pane-local switch.
    return `Claude panes are at ${weekly.usedPercent}%. \`/byt ${emailOf(best)}\` shows the plan to ${target}; \`/byt ${emailOf(best)} ok\` moves only the panes the plan approves. ${scope}`;
  }
  return "no action needed";
}

function resetLabel(resetsAt) {
  const at = new Date(resetsAt);
  if (!resetsAt || !Number.isFinite(at.getTime())) return "reset unknown";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at).map(({ type, value }) => [type, value]));
  return `resets ${parts.month} ${parts.day} ${parts.hour}:${parts.minute}`;
}

/** WHAT: Formats one scoped action and every account with its panes. WHY: Lets the human see unused logins and which pane a switch would move. */
export function formatQuotaWarning(snapshot, { config = parseQuotaWarningConfig(), now = Date.now() } = {}) {
  const accounts = snapshot?.accounts || [], active = accounts.filter(account => !loggedOut(account));
  const lines = active.flatMap(account => {
    const weekly = weeklyQuotaOf(account) || account.limits?.find(limit => limit.kind === "weekly");
    const slots = account.sharedBy?.filter(member => member.source !== "login").map(member => member.id);
    const id = slots?.length ? slots.join("+") : account.profile?.id;
    const known = Number.isFinite(weekly?.usedPercent);
    const icon = !known ? "⚪" : weekly.usedPercent >= config.reservePercent ? "🔴" : weekly.usedPercent >= config.warnPercent ? "⚠️" : "🟢";
    const usage = known ? `**${weekly.usedPercent}%** used` : "weekly unknown";
    const panes = account.inUse?.length ? compactPaneList(account.inUse) : "no panes";
    return [`${icon} **${providerName(account)}${id ? ` ${id}` : ""}** · ${emailOf(account)} · ${usage} · ${resetLabel(weekly?.resetsAt)}`,
      `↳ ${panes}`];
  });
  const out = accounts.filter(loggedOut).map(account => `${providerName(account)} ${emailOf(account)}`);
  return [`**Weekly quota** · ${actionLine(accounts, config, now)}`, ...lines, ...(out.length ? [`Logged out: ${out.join(" · ")}`] : [])].join("\n");
}

/**
 * WHAT: Dispatches the due warnings for accounts panes run on in one message and records them.
 * WHY: Keeps the human from warnings more often than their cooldown or about accounts no pane uses.
 */
export async function postDueQuotaWarnings({ snapshot, notify, sent, config = parseQuotaWarningConfig(), now = Date.now() }) {
  if (!config.enabled) return [];
  const accounts = snapshot?.accounts || [], due = [];
  for (const account of accounts) {
    const weekly = weeklyQuotaOf(account), email = account.account?.email;
    const resetAt = Date.parse(weekly?.resetsAt), cooldownMs = warningCooldownMs(weekly?.usedPercent, config);
    if (!email || !account.inUse?.length || cooldownMs === null || !(resetAt > now)) continue;
    const identity = account.provider === "claude" ? email : `${account.provider}:${email}`;
    const key = weeklyWindowKey(identity, weekly.resetsAt), accountKey = weeklyWindowKey(identity, "1970-01-01T00:00:00Z");
    const lastAt = Math.max(sent.entry(key)?.reminder?.at ?? -Infinity, sent.entry(accountKey)?.reminder?.at ?? -Infinity);
    if (now - lastAt < cooldownMs) continue;
    due.push({ provider: account.provider, email, usedPercent: weekly.usedPercent, key, accountKey, resetAt });
  }
  if (!due.length) return due;
  await notify(formatQuotaWarning(snapshot, { config, now }));
  for (const notice of due) {
    sent.record(notice.accountKey, notice.usedPercent, { now, resetAt: notice.resetAt });
    sent.record(notice.key, notice.usedPercent, { now, resetAt: notice.resetAt });
  }
  return due;
}
