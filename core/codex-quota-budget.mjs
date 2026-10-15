// Shared dashboard observations. Recovery keeps its independent fresh reader.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readCodexAccountQuota } from "./codex-account-quota.mjs";
import { QUOTA_REFRESH_INTERVAL_MS } from "./quota-observation.mjs";
import { tryLockDir } from "./dir-lock.mjs";

const readEntry = path => {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
const accountIdentity = profile => {
  try { return JSON.parse(readFileSync(profile.credentialsPath || join(profile.home, "auth.json"), "utf8"))?.tokens?.account_id || ""; }
  catch { return ""; }
};

/** WHAT: Reads Codex quota through a shared fifteen-minute dashboard budget. WHY: Prevents reminder and dashboard consumers from duplicating app-server reads. */
export async function readCodexQuotaBudgeted(profile, { now = Date.now, read = readCodexAccountQuota,
  cacheOnly = false, budgetDir = join(homedir(), ".agentmux", "quota-budget", "codex"),
  sleep = ms => new Promise(done => setTimeout(done, ms)), ...options } = {}) {
  const key = createHash("sha256").update(`${resolve(profile.home)}:${accountIdentity(profile)}`).digest("hex").slice(0, 32);
  const path = join(budgetDir, `${key}.json`);
  const cached = () => {
    const entry = readEntry(path);
    return entry && now() >= entry.attemptedAt && now() - entry.attemptedAt < QUOTA_REFRESH_INTERVAL_MS
      ? entry.result : null;
  };
  const existing = cached();
  if (existing) return existing;
  const unavailable = error => ({ ok: false, provider: "codex", engine: "codex", profile, error });
  if (cacheOnly) return unavailable("quota_cache_unavailable");
  mkdirSync(budgetDir, { recursive: true, mode: 0o700 });
  const lockPath = join(budgetDir, `${key}.lock`);
  let release = tryLockDir(lockPath, { staleMs: 30_000 });
  for (let waited = 0; !release && waited < 15_000; waited += 50) {
    await sleep(50);
    const landed = cached();
    if (landed) return landed;
    release = tryLockDir(lockPath, { staleMs: 30_000 });
  }
  if (!release) return unavailable("quota_read_busy");
  try {
    const landed = cached();
    if (landed) return landed;
    const attemptedAt = now(), result = await read(profile, { ...options, now });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ attemptedAt, result }), { mode: 0o600 });
    renameSync(temporary, path);
    return result;
  } finally { release(); }
}
