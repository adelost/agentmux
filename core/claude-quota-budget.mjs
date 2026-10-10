// One Claude usage call per account per five minutes, shared by every amux
// process: the CLI, Discord /quota and the bridge's quota recovery. Anthropic
// counts the usage endpoint's 429 budget per account, so every attempt that
// reached the provider is recorded, not only successes. Stored results hold
// limits and the account email, never tokens.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readClaudeProfileIdentity, readClaudeQuota } from "./claude-account-quota.mjs";
import { tryLockDir } from "./dir-lock.mjs";

/** WHAT: Defines the minimum time between usage calls for one account. WHY: Keeps all readers inside the provider's per-account budget. */
export const CLAUDE_USAGE_MIN_INTERVAL_MS = 5 * 60_000;
// One read is at most a 10 s refresh plus a 10 s usage request.
const READ_LOCK_STALE_MS = 30_000;
const WAIT_STEP_MS = 250;
// Decided before any request: these spend no budget and may be retried at once.
const LOCAL_FAILURES = new Set([
  "credentials_unavailable", "credentials_expired", "login_expired", "refresh_busy",
]);

/** WHAT: Names the shared budget directory. WHY: Keeps CLI and bridge on one record. */
export const claudeQuotaBudgetDir = (env = process.env) =>
  join(resolve(env.HOME || homedir()), ".agentmux", "quota-budget", "claude");

/** WHAT: Names the budget record by account, not by slot. WHY: Keeps two slots on one login from spending two budgets. */
export const claudeQuotaBudgetKey = (profile, identity) => createHash("sha256")
  .update(identity?.email
    ? `email:${identity.email.toLowerCase()}`
    : `path:${resolve(String(profile?.credentialsPath || ""))}`)
  .digest("hex")
  .slice(0, 32);

const windowResetSince = (result, now) => result?.ok === true && Array.isArray(result.limits)
  && result.limits.some((limit) => Date.parse(limit?.resetsAt) <= now);

const isFresh = (entry, now, notBefore) => Number.isFinite(entry?.attemptedAt)
  && now - entry.attemptedAt < CLAUDE_USAGE_MIN_INTERVAL_MS
  && entry.attemptedAt >= notBefore
  && !windowResetSince(entry.result, now);

const readEntry = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
};

const writeEntry = (path, entry) => {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(entry), { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch {}
  }
};

// Recovery only resumes a pane whose own slot produced the reading.
const asCallersProfile = (result, profile) => ({ ...result, profile: {
  id: profile.id, key: profile.key, label: profile.label, source: profile.source,
} });

// `notBefore` rejects older readings, so a pane parked on its limit never resumes on one taken before it.
/**
 * WHAT: Reads one Claude account's usage, reusing a reading from the last five minutes.
 * WHY: Keeps processes sharing an account from spending its usage budget twice.
 */
export async function readClaudeQuotaBudgeted({
  profile,
  notBefore = 0,
  now = Date.now,
  read = readClaudeQuota,
  budgetDir = claudeQuotaBudgetDir(),
  identityOf = readClaudeProfileIdentity,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  waitMs = 15_000,
  ...readOptions
} = {}) {
  const key = claudeQuotaBudgetKey(profile, identityOf(profile));
  const entryPath = join(budgetDir, `${key}.json`);
  const stored = () => {
    const entry = readEntry(entryPath);
    return isFresh(entry, now(), notBefore) ? asCallersProfile(entry.result, profile) : null;
  };
  const cached = stored();
  if (cached) return cached;

  mkdirSync(budgetDir, { recursive: true, mode: 0o700 });
  const lockPath = join(budgetDir, `${key}.lock`);
  let release = tryLockDir(lockPath, { staleMs: READ_LOCK_STALE_MS });
  for (let waited = 0; !release && waited < waitMs; waited += WAIT_STEP_MS) {
    await sleep(WAIT_STEP_MS);
    const landed = stored();
    if (landed) return landed;
    release = tryLockDir(lockPath, { staleMs: READ_LOCK_STALE_MS });
  }
  if (!release) {
    return asCallersProfile({ ok: false, engine: "claude", provider: "claude",
      error: "quota_read_busy" }, profile);
  }
  try {
    const landed = stored();
    if (landed) return landed;
    const attemptedAt = now();
    const result = await read({ profile, now, ...readOptions });
    if (!LOCAL_FAILURES.has(result?.error)) writeEntry(entryPath, { attemptedAt, result });
    return result;
  } finally {
    release();
  }
}
