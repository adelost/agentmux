// Human-only reserve reminders based on shared quota observations.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { formatReset } from "../core/quota-format.mjs";

const HOUR = 3_600_000;
const positiveNumber = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

/** WHAT: Reads reserve reminder settings. WHY: Keeps hourly limits independent of operator poll cadence. */
export function parseQuotaWarningConfig(env = process.env) {
  return { enabled: env.AMUX_QUOTA_WARNING_ENABLED !== "false",
    reservePercent: Math.min(100, positiveNumber(env.AMUX_QUOTA_RESERVE_PERCENT, 90)),
    pollMs: Math.max(5 * 60_000, positiveNumber(env.AMUX_QUOTA_WARN_POLL_MS, 15 * 60_000)) };
}

/** WHAT: Names one account's weekly window. WHY: Keeps restart deduplication stable across reset-time drift. */
export const weeklyWindowKey = (identity, resetsAt) => `${createHash("sha256")
  .update(String(identity).toLowerCase()).digest("hex").slice(0, 16)}:${Math.round(Date.parse(resetsAt) / HOUR)}`;

/** WHAT: Stores baseline usage and the last reminder atomically. WHY: Prevents restarts from resetting the hourly cooldown. */
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
    baseline(key, usedPercent, options) {
      update(key, { baseline: { at: options.now, usedPercent,
        cooldownAt: options.legacyReserve ? options.now : null } }, options);
    },
    record(key, usedPercent, options) { update(key, { reminder: { at: options.now, usedPercent } }, options); },
  };
}

/** WHAT: Extracts the account's weekly quota. WHY: Prevents short and scoped windows from triggering reserve reminders. */
export function weeklyQuotaOf(account) {
  if (!account?.ok) return null;
  if (account.provider === "claude") return account.limits?.find(limit => limit.kind === "weekly_all") || null;
  if (account.provider === "codex") return (account.limits?.find(limit => limit.limitId === "codex")
    || account.limits?.[0])?.windows?.find(window => window.windowMinutes === 10080) || null;
  return null;
}

/** WHAT: Builds a concise account-switch suggestion. WHY: Keeps account changes an explicit human choice. */
export function formatReserveReminder(account, weekly, alternatives, reservePercent) {
  const provider = account.provider === "claude" ? "Claude" : "Codex";
  const headline = `${provider} ${account.account.email}: ${weekly.usedPercent} % av veckan, ${formatReset(weekly.resetsAt)}.`;
  const best = alternatives[0];
  if (!best) return `${headline} Inget annat ${provider}-konto har plats under ${reservePercent} %.`;
  const command = account.provider === "claude"
    ? `\`/byt ${best.account.email}\` visar planen, \`/byt ${best.account.email} ok\` byter.`
    : `\`//switch ${best.profile.id}\` i Discord.`;
  return `${headline}\nDu kan byta till ${best.account.email} (${weeklyQuotaOf(best).usedPercent} %): ${command}`;
}

/** WHAT: Dispatches hourly reminders for growing, actively used reserve accounts. WHY: Keeps idle accounts and panels undisturbed. */
export async function runQuotaWarningTick({ snapshot, notify, sent, config = parseQuotaWarningConfig(), now = Date.now() }) {
  const notices = [];
  if (!config.enabled) return notices;
  const accounts = snapshot?.accounts || [];
  for (const account of accounts) {
    const weekly = weeklyQuotaOf(account), email = account.account?.email;
    const resetAt = Date.parse(weekly?.resetsAt);
    if (!email || !Number.isFinite(weekly?.usedPercent) || !(resetAt > now)) continue;
    const identity = account.provider === "claude" ? email : `${account.provider}:${email}`;
    const key = weeklyWindowKey(identity, weekly.resetsAt), previous = sent.entry(key);
    const accountKey = weeklyWindowKey(identity, "1970-01-01T00:00:00Z");
    const baseline = previous?.reminder || previous?.baseline;
    if (!baseline) {
      sent.baseline(key, weekly.usedPercent, { now, resetAt, legacyReserve: previous?.levels?.includes("reserve") });
      continue;
    }
    const lastAt = Math.max(previous?.reminder?.at ?? baseline.cooldownAt ?? -Infinity,
      sent.entry(accountKey)?.reminder?.at ?? -Infinity);
    if (!account.inUse?.length || weekly.usedPercent < config.reservePercent
        || weekly.usedPercent <= baseline.usedPercent || now - lastAt < HOUR) continue;
    const alternatives = accounts.filter(other => other.provider === account.provider && other.account?.email
      && other.account.email.toLowerCase() !== email.toLowerCase()
      && (other.provider !== "codex" || /^[12]$/u.test(String(other.profile?.id)))
      && Number.isFinite(weeklyQuotaOf(other)?.usedPercent) && Date.parse(weeklyQuotaOf(other)?.resetsAt) > now
      && weeklyQuotaOf(other).usedPercent < config.reservePercent)
      .sort((a, b) => weeklyQuotaOf(a).usedPercent - weeklyQuotaOf(b).usedPercent);
    const text = formatReserveReminder(account, weekly, alternatives, config.reservePercent);
    await notify(text, { level: "info", title: "Kontokvot",
      idempotencyKey: `quota-reserve:${account.provider}:${key}:after:${baseline.at}` });
    sent.record(accountKey, weekly.usedPercent, { now, resetAt });
    sent.record(key, weekly.usedPercent, { now, resetAt });
    notices.push({ provider: account.provider, email, level: "reserve", text });
  }
  return notices;
}

/** WHAT: Schedules non-overlapping reminder ticks. WHY: Prevents slow reads from stacking bridge work. */
export function createQuotaWarningLoop({ tick, config = parseQuotaWarningConfig(), log = message => console.log(`quota-warning | ${message}`),
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval } = {}) {
  let running = false, intervalId = null;
  const run = async () => {
    if (running) return;
    running = true;
    try { for (const notice of await tick()) log(`${notice.level} sent for ${notice.provider}:${notice.email}`); }
    catch (error) { log(`tick failed: ${error.message}`); }
    finally { running = false; }
  };
  return {
    start() { if (intervalId || !config.enabled) return;
      intervalId = setIntervalImpl(run, config.pollMs); intervalId?.unref?.(); void run(); },
    stop() { if (intervalId) clearIntervalImpl(intervalId); intervalId = null; },
    run,
  };
}
