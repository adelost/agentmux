// Observes foreign drafts through read-only tmux captures and queues dispatcher notices.
import { listAgents } from "../cli/config.mjs";
import { accountEngineForCommand } from "../core/runtime-account-profiles.mjs";
import { createTmuxAdapter } from "../core/tmux.mjs";
import { createForeignDraftAlarm } from "../core/foreign-draft-alarm.mjs";
import { parseIdleCapacityConfig } from "./idle-capacity-runtime.mjs";

/** WHAT: Reads the dispatcher, off switch and sixty-second poll default. WHY: Keeps foreign-draft alerts independent from idle-capacity alert settings. */
export function parseForeignDraftConfig(env = process.env) {
  return parseIdleCapacityConfig({
    AMUX_IDLE_CAPACITY_TARGET: String(env.AMUX_FOREIGN_DRAFT_TARGET || "").trim() || env.AMUX_IDLE_CAPACITY_TARGET,
    AMUX_IDLE_CAPACITY_ALERT_ENABLED: env.AMUX_FOREIGN_DRAFT_ALERT_ENABLED,
    AMUX_IDLE_CAPACITY_POLL_MS: env.AMUX_FOREIGN_DRAFT_POLL_MS ?? 60_000,
  });
}

/**
 * WHAT: Schedules read-only Claude composer checks and enqueues notices to the configured dispatcher.
 * WHY: Keeps stuck drafts visible without typing, clearing, restarting or moving any pane.
 */
export function startForeignDraftAlarm({ queue, state, configPath, tmuxSocket, tmuxExec, profileFor = () => null,
  ownsDraft = () => false, config = parseForeignDraftConfig(), agents = () => listAgents(configPath),
  tmux = null, now = Date.now, log = (message) => console.log(`foreign-draft | ${message}`), setIntervalImpl = setInterval }) {
  if (!config.enabled) return null;
  const dispatcher = agents().find((agent) => agent.name === config.agentName);
  if (!dispatcher?.panes?.[config.pane]) {
    log(`off: ${config.target} is not a configured pane`);
    return null;
  }
  const reader = tmux ?? createTmuxAdapter({ socket: tmuxSocket, exec: tmuxExec });
  const alarm = createForeignDraftAlarm({ target: config.target, state, ownsDraft, now, log,
    panes: () => agents().filter((agent) => agent.backend !== "native").flatMap((agent) =>
      (agent.panes || []).flatMap((definition, pane) => accountEngineForCommand(definition?.cmd) === "claude"
        ? [{ key: `${agent.name}:${pane}`, agentName: agent.name, pane, engine: "claude" }] : [])),
    observe: async ({ agentName, pane }) => ({
      screen: await reader.captureScreen(`${agentName}:.${pane}`),
      jobs: queue.list(agentName, pane),
      profileHome: profileFor(agentName, pane)?.home ?? null,
    }),
    notify: (text, idempotencyKey) => queue.enqueue({
      agentName: config.agentName, pane: config.pane, text, source: "foreign-draft", idempotencyKey,
    }),
  });
  const run = () => alarm.tick().catch((error) => log(`tick failed: ${error.message}`));
  const timer = setIntervalImpl(run, config.pollMs);
  timer?.unref?.();
  return { alarm, timer };
}
