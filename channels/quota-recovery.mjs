// Bridge-owned Claude quota recovery loop.
//
// Detection is local and exact (session JSONL); readiness comes from the fresh
// OAuth usage endpoint when available, with the banner's absolute reset as a
// conservative fallback. The delivery broker owns the destructive restart and
// FIFO transition so this poller never types directly into a pane.

import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { claudeQuotaRecoveryReadiness } from "../core/claude-quota-recovery.mjs";
import { readClaudeQuota } from "../core/quota-usage.mjs";

const positiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export function parseQuotaRecoveryConfig(env = process.env) {
  return {
    enabled: env.AMUX_QUOTA_RECOVERY_ENABLED !== "false",
    pollMs: positiveInt(env.AMUX_QUOTA_RECOVERY_POLL_MS, 30_000),
    resetGraceMs: positiveInt(env.AMUX_QUOTA_RECOVERY_RESET_GRACE_MS, 15_000),
  };
}

const isClaudePane = (pane) => /claude/i.test(String(pane?.cmd || pane?.name || ""));

export function createQuotaRecovery({
  agent,
  deliveryBroker,
  agentsYamlPath,
  discord = null,
  config = parseQuotaRecoveryConfig(),
  readQuota = () => readClaudeQuota(),
  now = () => Date.now(),
  log = (message) => console.log(`quota-recovery | ${message}`),
} = {}) {
  if (!agent) throw new Error("quota recovery requires agent");
  if (!deliveryBroker) throw new Error("quota recovery requires delivery broker");
  let intervalId = null;
  let inFlight = null;

  async function recoverOne(target, quota) {
    const readiness = claudeQuotaRecoveryReadiness(target.receipt, quota, {
      now: now(),
      resetGraceMs: config.resetGraceMs,
    });
    if (!readiness.ready) return { ...target, readiness };

    const result = await deliveryBroker.recoverClaudeQuota({
      agentName: target.agentName,
      pane: target.pane,
      receipt: target.receipt,
    });
    if (!result.recovered) {
      log(`${target.agentName}:${target.pane} held: ${result.reason}`);
      return { ...target, readiness, result };
    }
    await deliveryBroker.kickTarget(target.agentName, target.pane);
    const job = result.job?.id
      ? deliveryBroker.queue.read(target.agentName, target.pane, result.job.id)
      : result.job;
    if (result.restarted) {
      const channelId = findChannelForPane(agentsYamlPath, target.agentName, target.pane);
      if (channelId && discord) {
        const delivered = job?.status === "acknowledged";
        await discord.send(channelId, delivered
          ? "✅ Kvoten är tillbaka. AMUX återstartade exakt samma Claude-session och fortsättningsturen är levererad."
          : "✅ Kvoten är tillbaka. AMUX återstartade exakt samma Claude-session; fortsättningsturen ligger durabelt först i kön.")
          .catch((error) => log(`${target.agentName}:${target.pane} recovery notice failed: ${error.message}`));
      }
      log(`${target.agentName}:${target.pane} resumed ${target.receipt.sessionId} via ${readiness.via}; continuation=${job?.status || "unknown"}`);
    }
    return { ...target, readiness, result, job };
  }

  async function runTick() {
    if (!config.enabled) return [];
    let configured;
    try { configured = listAgents(agentsYamlPath); }
    catch (error) {
      log(`config read failed: ${error.message}`);
      return [];
    }

    const limited = [];
    for (const entry of configured) {
      if (entry.backend === "native") continue;
      for (let pane = 0; pane < (entry.panes || []).length; pane++) {
        if (!isClaudePane(entry.panes[pane])) continue;
        let receipt = null;
        try { receipt = await agent.claudeLimitReceipt(entry.name, pane); }
        catch (error) { log(`${entry.name}:${pane} receipt read failed: ${error.message}`); }
        if (receipt) limited.push({ agentName: entry.name, pane, receipt });
      }
    }
    if (!limited.length) return [];

    let quota;
    try { quota = await readQuota(); }
    catch (error) { quota = { ok: false, engine: "claude", error: error.message }; }
    const results = [];
    // Sequential recovery is deliberate: every Claude pane may share one
    // subscription, but each restart is its own exact-session transaction.
    for (const target of limited) results.push(await recoverOne(target, quota));
    return results;
  }

  function tick() {
    if (inFlight) return inFlight;
    inFlight = runTick().finally(() => { inFlight = null; });
    return inFlight;
  }

  function start() {
    if (!config.enabled) {
      log("disabled (AMUX_QUOTA_RECOVERY_ENABLED=false)");
      return;
    }
    if (intervalId) return;
    log(`enabled | poll=${Math.round(config.pollMs / 1000)}s reset-grace=${Math.round(config.resetGraceMs / 1000)}s`);
    intervalId = setInterval(() => {
      tick().catch((error) => log(`tick failed: ${error.message}`));
    }, config.pollMs);
    intervalId.unref?.();
    void tick();
  }

  function stop() {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
  }

  return { start, stop, tick };
}
