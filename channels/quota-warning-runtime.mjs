// Checks quota when the human writes and answers in that channel with the warning that is due.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readQuotaSnapshotWithPanes } from "../core/quota-in-use.mjs";
import { readQuotaSnapshot } from "../core/quota-usage.mjs";
import { quotaAccountCatalog } from "../core/quota-profiles.mjs";
import { listAgents } from "../cli/config.mjs";
import { createTmuxContext, getPaneStatus } from "../cli/tmux.mjs";
import { runtimeAgentsPath, DEFAULT_TMUX_SOCKET } from "../core/runtime-defaults.mjs";
import { latestConversationActivityMs } from "../core/pane-activity.mjs";
import { panePathFor } from "../core/jsonl-reader.mjs";
import { createSentNoticeStore, parseQuotaWarningConfig, postDueQuotaWarnings } from "./quota-warning.mjs";
import { weeklyQuotaOf } from "./quota-overview.mjs";

/**
 * WHAT: Reads every account and its panes through the dashboard's shared quota budget.
 * WHY: Prevents a cold cache from silencing the warning whenever nobody ran amux quota recently.
 */
export async function readWarningSnapshot({ readSnapshot = () => {
  const profiles = quotaAccountCatalog();
  return readQuotaSnapshotWithPanes({ profiles, readSnapshot: () => readQuotaSnapshot({ profiles }) });
}, readActivity = readWarningActivity, config = parseQuotaWarningConfig() } = {}) {
  return readActivity(await readSnapshot(), { config });
}

/** WHAT: Reads live account panes with work now or within one hour. WHY: Prevents parked terminals from counting as subscription use. */
export async function readWarningActivity(snapshot, { now = Date.now(), config = parseQuotaWarningConfig(),
  agents = listAgents(runtimeAgentsPath()), statusFor = null,
  activityFor = (dir, engine) => latestConversationActivityMs(dir, engine),
} = {}) {
  let context;
  const status = statusFor || ((name, pane) => {
    context ||= createTmuxContext(process.env.TMUX_SOCKET || DEFAULT_TMUX_SOCKET, runtimeAgentsPath());
    return getPaneStatus(context, name, pane);
  });
  const accounts = await Promise.all((snapshot?.accounts || []).map(async account => {
    if (!(weeklyQuotaOf(account)?.usedPercent >= config.warnPercent)) return { ...account, activeInUse: [] };
    const active = await Promise.all((account.inUse || []).map(async key => {
      const [name, index] = key.split(":"), pane = Number(index), agent = agents.find(item => item.name === name);
      if (!agent) return null;
      try {
        if (await status(name, pane) === "working") return key;
        const at = activityFor(panePathFor(agent, pane), account.provider, pane);
        return Number.isFinite(at) && now - at >= 0 && now - at <= 3_600_000 ? key : null;
      } catch { return null; } // Unknown activity cannot qualify a warning.
    }));
    return { ...account, activeInUse: active.filter(Boolean) };
  }));
  return { ...snapshot, accounts };
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
  return (msg, { fullOnly = false, notify = null, editNotice = null } = {}) => {
    const check = previous.then(async () => {
      const config = parseQuotaWarningConfig(env);
      if (!config.enabled) return [];
      const snapshot = await readSnapshot({ config });
      const notices = await postDueQuotaWarnings({ snapshot, sent, config, fullOnly, editNotice, channelId: msg?.channelId,
        notify: notify || (text => msg.send(text, { kind: "notice" })) });
      observe({ mode: fullOnly ? "reached-limit-pulse" : "on-human-message", warnPercent: config.warnPercent, reservePercent: config.reservePercent,
        accounts: snapshot?.accounts?.length || 0, notices: notices.length });
      return notices;
    }).catch((error) => { log(`check failed: ${error.message}`); return []; });
    previous = check;
    return check;
  };
}

/** WHAT: Names the bridge's single warning hook, which bot.mjs calls for each human message. WHY: Keeps one check queue per bridge from splitting across callers. */
export const warnQuotaOnHumanMessage = createQuotaWarningOnWrite();

/** WHAT: Routes newly full accounts from the existing bridge heartbeat. WHY: Quota exhaustion must be visible without another human message. */
export function createQuotaLimitPoll({ channels, channelMap, check = warnQuotaOnHumanMessage }) {
  return () => check(null, { fullOnly: true, editNotice: (ref, text) => channels[0].editMessage(ref.channelId, ref.messageId, text), notify: async (text, notices) => {
    const panes = new Set(notices.flatMap(notice => notice.panes));
    const target = [...channelMap()].find(([, value]) => panes.has(`${value.name}:${value.pane ?? 0}`));
    if (!target || !channels[0]) throw new Error("full quota notice has no affected channel");
    const posted = await channels[0].send(target[0], text, { kind: "notice" });
    return { messageId: posted?.id, channelId: target[0] };
  } });
}
