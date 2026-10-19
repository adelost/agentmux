// Claude Code saves every interactive /model pick as the default for new
// sessions ("Set model to … and saved as your default for new sessions",
// 2.1.303), in the settings.json that every account profile links to. A pane
// switch is not a new default: on 2026-10-19 the builders' switches to Sonnet
// made every session started by hand start on Sonnet (claw:0, lsrc:0).

import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { tryLockDir } from "./dir-lock.mjs";
import { claudeLoginProfiles, quotaProfileCatalog } from "./quota-profiles.mjs";

// Claude Code waits up to 3 s for its own write before it answers the command.
const LATE_WRITE_MS = 3_000;
const LOCK_WAIT_MS = 20_000;
const LOCK_STALE_MS = 5 * 60_000;
const POLL_MS = 100;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** WHAT: Collects the settings files a Claude pane saves its /model pick to. WHY: Keeps a profile holding its own file from keeping a pane's pick. */
export function claudeSettingsFiles(env = process.env) {
  const homes = [
    ...quotaProfileCatalog(env).filter((profile) => profile.provider === "claude").map((profile) => profile.home),
    ...claudeLoginProfiles(env).map((profile) => profile.home),
  ];
  const files = new Set();
  for (const home of homes) {
    try { files.add(realpathSync(join(home, "settings.json"))); } catch { /* no settings file: no default to keep */ }
  }
  return [...files];
}

const savedDefault = (path) => {
  const settings = JSON.parse(readFileSync(path, "utf-8"));
  return Object.hasOwn(settings, "model") ? { model: settings.model } : {};
};
const sameDefault = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function defaultState({ path, saved }) {
  try { return sameDefault(savedDefault(path), saved) ? "kept" : "changed"; }
  catch { return "unreadable"; }
}

/** WHAT: Writes one file's saved default back, leaving every other setting as it is. WHY: Readers see the old or the new file, never half of it. */
function putBack({ path, saved }) {
  const settings = JSON.parse(readFileSync(path, "utf-8"));
  if (Object.hasOwn(saved, "model")) settings.model = saved.model;
  else delete settings.model;
  const temp = join(dirname(path), `.${basename(path)}.amux-${process.pid}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: statSync(path).mode & 0o777 });
    renameSync(temp, path);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* the temp file was never written */ }
    throw error;
  }
}

async function restoreDefaults(before, { wait, now, lateWriteMs }) {
  // A pick Claude Code has not finished saving shows up within its own write window.
  const deadline = now() + lateWriteMs;
  while (now() < deadline && !before.some((entry) => defaultState(entry) === "changed")) await wait(POLL_MS);
  return putBackChanged(before);
}

function putBackChanged(before) {
  const restored = [], failed = [];
  for (const entry of before) {
    const state = defaultState(entry);
    if (state === "kept") continue;
    if (state === "unreadable") { failed.push({ path: entry.path, error: "unreadable after the switch" }); continue; }
    try { putBack(entry); restored.push(entry.path); }
    catch (error) { failed.push({ path: entry.path, error: error.message }); }
  }
  return { restored, failed };
}

async function takeLock(path, { wait, now, lockWaitMs }) {
  mkdirSync(dirname(path), { recursive: true });
  const deadline = now() + lockWaitMs;
  for (;;) {
    const release = tryLockDir(path, { staleMs: LOCK_STALE_MS });
    if (release || now() >= deadline) return release;
    await wait(POLL_MS);
  }
}

/**
 * WHAT: Wraps one pane's /model and puts back the default for new sessions it saved.
 * WHY: Keeps a builder's model out of the sessions started by hand.
 */
export async function keepClaudeDefaultModel(work, {
  files = claudeSettingsFiles(),
  lockPath = join(homedir(), ".agentmux", "claude-default-model.lock"),
  wait = pause, now = Date.now, lateWriteMs = LATE_WRITE_MS, lockWaitMs = LOCK_WAIT_MS,
} = {}) {
  // One switch at a time, so a second switch never records the first one's pick as the default to restore.
  const release = await takeLock(lockPath, { wait, now, lockWaitMs });
  if (!release) return { busy: true };
  try {
    const before = files.flatMap((path) => {
      try { return [{ path, saved: savedDefault(path) }]; }
      catch { return []; } // Claude Code cannot save into a file it cannot parse either.
    });
    // The work gets what to keep, so a switch that lands after this returns can still put it back.
    const outcome = await work({ files: before, lockPath }).then((result) => ({ result }), (error) => ({ error }));
    const defaults = await restoreDefaults(before, { wait, now, lateWriteMs });
    if (outcome.error) throw outcome.error;
    return { result: outcome.result, defaults };
  } finally { release(); }
}

/**
 * WHAT: Saves the kept default back over a /model pick saved after keepClaudeDefaultModel returned.
 * WHY: Keeps a switch amux could not verify from leaving its pick as the default (skyvw:2, 2026-10-19).
 */
export function putBackLandedDefault({ files = [], lockPath = null } = {}) {
  if (!lockPath) return { restored: [], failed: [] }; // nothing was kept
  // A switch in progress holds the lock and puts back its own default.
  const release = tryLockDir(lockPath, { staleMs: LOCK_STALE_MS });
  if (!release) return { busy: true };
  try { return putBackChanged(files); } finally { release(); }
}
