// Runs the idle-capacity alarm against the configured fleet, its delivery queue, tmux and the quota snapshot.

import { listAgents } from "../cli/config.mjs";
import { getPaneStatus } from "../cli/tmux.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue-policy.mjs";
import { accountEngineForCommand } from "../core/runtime-account-profiles.mjs";
import { createTmuxAdapter } from "../core/tmux.mjs";
import { readQuotaSnapshot } from "../core/quota-usage.mjs";
import { quotaAccountCatalog } from "../core/quota-profiles.mjs";
import { accountWithRoom } from "../core/account-room.mjs";
export { accountWithRoom } from "../core/account-room.mjs";
import { createIdleCapacityAlarm } from "../core/idle-capacity-alarm.mjs";
import { parseQuotaWarningConfig } from "./quota-warning.mjs";

const SHELL_PROCESS = /^(bash|zsh|fish|sh|dash)$/u;
const positiveInt = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

/**
 * WHAT: Reads the dispatcher pane, the check interval and the off switch.
 * WHY: Keeps the pane that staffs a fleet an operator setting instead of product code.
 */
export function parseIdleCapacityConfig(env = process.env) {
  const target = String(env.AMUX_IDLE_CAPACITY_TARGET || "").trim();
  const match = /^([\w.-]+):(\d+)$/u.exec(target);
  return {
    enabled: env.AMUX_IDLE_CAPACITY_ALERT_ENABLED !== "false" && Boolean(match),
    target,
    agentName: match?.[1] || null,
    pane: match ? Number(match[2]) : null,
    pollMs: positiveInt(env.AMUX_IDLE_CAPACITY_POLL_MS, 5 * 60_000),
  };
}

function enginePanes(configPath) {
  return listAgents(configPath)
    .filter((agent) => agent.backend !== "native")
    .flatMap((agent) => (agent.panes || []).flatMap((definition, pane) => {
      const engine = accountEngineForCommand(definition?.cmd);
      return engine === "claude" || engine === "codex"
        ? [{ key: `${agent.name}:${pane}`, agentName: agent.name, pane, engine }]
        : [];
    }));
}

/**
 * WHAT: Schedules the alarm on its own timer next to quota recovery.
 * WHY: Keeps unused paid capacity from going unreported; the alarm never wakes or moves panes.
 */
export function startIdleCapacityAlarm({
  queue,
  state,
  configPath,
  tmuxSocket,
  tmuxExec,
  activeReceipt,
  profileFor = () => null,
  parkStore = null,
  readPaneStatus = null,
  config = parseIdleCapacityConfig(),
  readSnapshot = () => readQuotaSnapshot({ profiles: quotaAccountCatalog().filter((profile) => profile.provider !== "kimi") }),
  log = (message) => console.log(`idle-capacity | ${message}`),
  setIntervalImpl = setInterval,
}) {
  if (!config.enabled) return null;
  // A notice to a pane that does not exist would wait in the queue forever.
  const dispatcher = listAgents(configPath).find((agent) => agent.name === config.agentName);
  if (!dispatcher?.panes?.[config.pane]) {
    log(`off: ${config.target} is not a configured pane`);
    return null;
  }
  const tmux = createTmuxAdapter({ socket: tmuxSocket, exec: tmuxExec });
  // What tmux shows now: a pane that works or thinks is not stuck, whatever its receipt or park record still says.
  const livePaneStatus = readPaneStatus ?? (({ agentName, pane }) => getPaneStatus({ tmux: tmux.raw, configPath }, agentName, pane).catch(() => "unknown"));
  const { reservePercent } = parseQuotaWarningConfig();
  const processStopped = async ({ agentName, pane }) => {
    if (!await tmux.hasSession(agentName).catch(() => false)) return true;
    return SHELL_PROCESS.test(await tmux.currentCommand(`${agentName}:.${pane}`).catch(() => ""));
  };
  let snapshot = null;
  const alarm = createIdleCapacityAlarm({
    target: config.target,
    state,
    panes: () => {
      snapshot = null;
      return enginePanes(configPath);
    },
    observe: async (pane) => {
      const history = queue.list(pane.agentName, pane.pane);
      const jobs = history.filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status));
      const claude = pane.engine === "claude";
      const limitReceipt = claude ? activeReceipt(pane.agentName, pane.pane) : null;
      const park = claude ? parkStore?.read(pane.agentName, pane.pane) ?? null : null;
      // A pane with nothing queued and no limit is idle by choice; tmux is read only for waiting work.
      const stopped = !limitReceipt && jobs.length ? await processStopped(pane) : false;
      const paneStatus = limitReceipt || jobs.length || park?.state === "parked" ? await livePaneStatus(pane) : "unknown";
      return { limitReceipt, jobs, processStopped: stopped, park, history, paneStatus,
        profileKey: claude ? profileFor(pane.agentName, pane.pane)?.key ?? null : null };
    },
    roomFor: async (engine) => {
      snapshot ||= await readSnapshot();
      return accountWithRoom(snapshot?.accounts, engine, { reservePercent });
    },
    notify: async (text, idempotencyKey) => queue.enqueue({
      agentName: config.agentName, pane: config.pane, text, source: "idle-capacity", idempotencyKey,
    }),
    log,
  });
  const run = () => alarm.tick().catch((error) => log(`tick failed: ${error.message}`));
  const timer = setIntervalImpl(run, config.pollMs);
  timer?.unref?.();
  return { alarm, timer };
}
