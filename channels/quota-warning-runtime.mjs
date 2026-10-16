// Checks quota when the human writes and answers in that channel with the warning that is due.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readQuotaSnapshotWithPanes } from "../core/quota-in-use.mjs";
import { readQuotaSnapshot } from "../core/quota-usage.mjs";
import { quotaAccountCatalog } from "../core/quota-profiles.mjs";
import { createSentNoticeStore, parseQuotaWarningConfig, postDueQuotaWarnings } from "./quota-warning.mjs";

/**
 * WHAT: Reads every account and its panes through the dashboard's shared quota budget.
 * WHY: Prevents a cold cache from silencing the warning whenever nobody ran amux quota recently.
 */
export function readWarningSnapshot() {
  const profiles = quotaAccountCatalog();
  return readQuotaSnapshotWithPanes({ profiles, readSnapshot: () => readQuotaSnapshot({ profiles }) });
}

/** WHAT: Records the last warning check. WHY: Keeps live-code verification independent of terminal output. */
function writeWarningHeartbeat(beat) {
  const dir = join(homedir(), ".agentmux"), path = join(dir, "quota-warning-heartbeat.json");
  mkdirSync(dir, { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify({ ...beat, pid: process.pid, ts: new Date().toISOString() }), { mode: 0o600 });
  renameSync(temporary, path);
}

// Mattias 2026-10-16: the warning comes in the window he writes in, when he writes.
/**
 * WHAT: Builds the hook that checks quota for one human message and answers in its channel.
 * WHY: Keeps two quick messages from warning twice by running one check at a time.
 */
export function createQuotaWarningOnWrite({ env = process.env, sent = createSentNoticeStore(), readSnapshot = readWarningSnapshot,
  observe = writeWarningHeartbeat, log = message => console.warn(`quota-warning | ${message}`) } = {}) {
  let previous = Promise.resolve();
  return (msg) => {
    const check = previous.then(async () => {
      const config = parseQuotaWarningConfig(env);
      if (!config.enabled) return [];
      const snapshot = await readSnapshot();
      const notices = await postDueQuotaWarnings({ snapshot, sent, config,
        notify: text => msg.send(text, { kind: "notice" }) });
      observe({ mode: "on-human-message", warnPercent: config.warnPercent, reservePercent: config.reservePercent,
        accounts: snapshot?.accounts?.length || 0, notices: notices.length });
      return notices;
    }).catch((error) => { log(`check failed: ${error.message}`); return []; });
    previous = check;
    return check;
  };
}

/** WHAT: Names the bridge's single warning hook, which bot.mjs calls for each human message. WHY: Keeps one check queue per bridge from splitting across callers. */
export const warnQuotaOnHumanMessage = createQuotaWarningOnWrite();
