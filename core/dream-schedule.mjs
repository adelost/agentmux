// Scheduling admission only. The existing Dream controller owns all model work.
import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  readdirSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { observeDreamHealth, readDreamSuccess } from "./dream-health.mjs";
import { localDateKey } from "./memory-policy.mjs";
import { dreamAttemptPath } from "./dream-schedule-state.mjs";

/** WHAT: Checks already completed or uncertain work. WHY: Prevents a missed cron check from resending an existing manual or interrupted run. */
export function scheduledDreamEvidence(workspace, dateKey, { home = process.env.HOME, now = new Date() } = {}) {
  if (readDreamSuccess(workspace, dateKey, { home, now }).ok) return "already-validated";
  try {
    const daily = readFileSync(join(workspace, "memory", `${dateKey}.md`), "utf8");
    if (daily.includes(`<!-- amux-dream-failed:${dateKey} `)
      || daily.includes(`<!-- amux-dream-run:${dateKey} `)) return "prior-run-needs-inspection";
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const inputDir = join(home, ".agentmux", "dream-input");
  let names;
  try { names = readdirSync(inputDir); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  for (const name of names.filter((name) => name.startsWith(`${dateKey}-`) && name.endsWith(".json"))) {
    const input = JSON.parse(readFileSync(join(inputDir, name), "utf8"));
    // Legacy inputs did not identify their workspace. Unknown is not permission.
    if (!input.workspace || resolve(input.workspace) === resolve(workspace)) return "prior-input-needs-recovery";
  }
  return null;
}

/** WHAT: Stores the scheduled attempt inside the controller lock. WHY: Prevents lock contention from consuming a night without an actual admitted attempt. */
export function claimScheduledDream(workspace, dateKey, { home = process.env.HOME, now = new Date(),
  token, mode, since,
}) {
  if (!token || dateKey !== localDateKey(now)) throw new Error("scheduled-dream-identity-invalid");
  const prior = scheduledDreamEvidence(workspace, dateKey, { home, now });
  if (prior) return { skipped: prior };
  const path = dreamAttemptPath(workspace, home, dateKey);
  const record = { schemaVersion: 1, dateKey, workspace: realpathSync(workspace), mode, token,
    since, startedAt: now.toISOString(), pid: process.pid, state: "started" };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") return { skipped: "already-attempted" };
    throw error;
  }
  try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
  return { path, record };
}

/** WHAT: Schedules at most one automatic attempt per day. WHY: Prevents quota loops and duplicate prompts across cron races, restarts and failed attempts. */
export async function runScheduledDream({ workspace, home = process.env.HOME, now = new Date(), dry = false,
  mode = "scheduled", healthOptions = {}, observe = observeDreamHealth, run,
}) {
  const health = observe(workspace, { ...healthOptions, home, now });
  if (health.state === "disabled") return { skipped: "disabled" };
  if (!Number.isFinite(health.startMs) || !health.dateKey) throw new Error(health.detail || "Dream schedule unverified");
  if (now.getTime() < health.startMs || health.dateKey !== localDateKey(now)) return { skipped: "not-due" };
  const dateKey = health.dateKey;
  const prior = scheduledDreamEvidence(workspace, dateKey, { home, now });
  if (prior) return { skipped: prior, dateKey };
  const path = dreamAttemptPath(workspace, home, dateKey);
  if (existsSync(path)) return { skipped: "already-attempted", dateKey, path };
  // Anchor the source window to the missed invocation, not the late wake-up.
  const since = new Date(health.startMs - 86_400_000).toISOString();
  if (dry) return { due: true, dateKey, since, mode, path, dry: true };
  const token = randomUUID();
  // The child claims only after getting the SAME lock as manual Dream.
  let exitCode = 1, error = null;
  try { exitCode = await run({ dateKey, since, token, mode }); }
  catch (failure) { error = failure.message; }
  let record;
  try { record = JSON.parse(readFileSync(path, "utf8")); }
  catch (failure) { if (failure.code !== "ENOENT") throw failure; }
  if (record?.token !== token) return { skipped: "not-admitted", dateKey, exitCode, ...(error ? { error } : {}) };
  // Never remove this intent on failure. Unknown post-submit means inspect/recover.
  const success = readDreamSuccess(workspace, dateKey, { home });
  const outcome = { ...record, finishedAt: new Date().toISOString(), exitCode,
    state: success.ok ? (exitCode === 0 ? "completed" : "maintenance-unresolved") : "unresolved",
    digest: success, ...(error ? { error } : {}) };
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(outcome, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  return { ...outcome, path, exitCode: exitCode || (success.ok ? 0 : 1) };
}
