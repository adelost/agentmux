import { join } from "node:path";
import { loadConfig, findChannelForPane } from "./config.mjs";
import { createCodexLimitRecovery } from "../core/codex-limit-recovery.mjs";
import { createContextMaintenance } from "../core/context-maintenance.mjs";
import { createColdDeliveryRule } from "../channels/pause-compact.mjs";
import { readPauseCompactModes } from "../core/pause-compact.mjs";

/** WHAT: Builds ordered account and context admission for queued work. WHY: Prevents compacting an exhausted account or delivering another refused prompt. */
export function createBridgeWorkAdmission({ agent, state, queue, configPath, selfRequests, discord, log }) {
  const notify = async (name, pane, text) => {
    const channelId = discord && findChannelForPane(configPath, name, pane);
    if (channelId) await discord.send(channelId, text, { kind: "notice" });
  };
  const maintenance = createContextMaintenance({ agent, state, queue, selfRequests, log,
    resolveTarget: (name, pane) => {
      const config = loadConfig(configPath)[name], cmd = config?.panes?.[pane]?.cmd || "";
      return config ? { engine: /codex/.test(cmd) ? "codex" : /claude/.test(cmd) ? "claude" : "unsupported",
        dir: join(config.dir, ".agents", String(pane)) } : null;
    },
    coldBeforeDelivery: createColdDeliveryRule({ modes: readPauseCompactModes() }),
    notify,
  });
  const recovery = createCodexLimitRecovery({ agent, state, broker: { queue }, log });
  const beforeWork = async (job, options) => {
    const cfg = loadConfig(configPath)[job.agentName];
    if (/\bcodex\b/u.test(cfg?.panes?.[job.pane]?.cmd || "")) {
      const verdict = await recovery.beforeDelivery(job, { ...options, dir: join(cfg.dir, ".agents", String(job.pane)) });
      if (!verdict.ok) return verdict;
    }
    return maintenance.beforeWork(job, options);
  };
  return { ...maintenance, beforeWork, notify };
}
