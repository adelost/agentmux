// The reminder loop consumes the same cached observations as amux quota.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { notifyUser } from "../cli/send-notify.mjs";
import { readQuotaSnapshotWithPanes } from "../core/quota-in-use.mjs";
import { readQuotaSnapshot } from "../core/quota-usage.mjs";
import { quotaAccountCatalog } from "../core/quota-profiles.mjs";
import { createQuotaWarningLoop, createSentNoticeStore, parseQuotaWarningConfig, runQuotaWarningTick } from "./quota-warning.mjs";

const LOOP_KEY = Symbol.for("agentmux.quotaWarningLoop");

/** WHAT: Reads cached quota through the dashboard's snapshot path. WHY: Prevents reminders from adding provider calls. */
export function readReminderSnapshot() {
  const profiles = quotaAccountCatalog().filter(profile => ["claude", "codex"].includes(profile.provider));
  return readQuotaSnapshotWithPanes({ profiles, readSnapshot: () => readQuotaSnapshot({ profiles,
    claude: { cacheOnly: true }, codex: { cacheOnly: true } }) });
}

/** WHAT: Builds a human-only tick with replaceable read and notification boundaries. WHY: Allows real-quota previews without sending or changing state. */
export function createQuotaWarningRuntimeTick({ env = process.env, notify = notifyUser,
  sent = createSentNoticeStore(), readSnapshot = readReminderSnapshot, observe = () => {} } = {}) {
  const config = parseQuotaWarningConfig(env);
  return async () => {
    const snapshot = await readSnapshot();
    const notices = await runQuotaWarningTick({ snapshot, notify, sent, config });
    observe({ mode: "human-only-hourly-growth", cacheOnly: true, reservePercent: config.reservePercent,
      accounts: snapshot.accounts?.length || 0, notices: notices.length });
    return notices;
  };
}

/** WHAT: Records the running reminder loop after each tick. WHY: Keeps live-code verification independent of terminal output. */
function writeWarningHeartbeat(beat) {
  const dir = join(homedir(), ".agentmux"), path = join(dir, "quota-warning-heartbeat.json");
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...beat, pid: process.pid, ts: new Date().toISOString() }), { mode: 0o600 });
  renameSync(temporary, path);
}

/** WHAT: Schedules one reminder loop per bridge process. WHY: Prevents duplicate loops on repeated preloads. */
export function startQuotaWarning(env = process.env) {
  const config = parseQuotaWarningConfig(env);
  if (!config.enabled || globalThis[LOOP_KEY]) return globalThis[LOOP_KEY] || null;
  const loop = createQuotaWarningLoop({ config, tick: createQuotaWarningRuntimeTick({ env, observe: writeWarningHeartbeat }) });
  globalThis[LOOP_KEY] = loop;
  loop.start();
  return loop;
}
