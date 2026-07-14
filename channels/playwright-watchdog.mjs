import {
  detectActivePlaywrightTool,
  formatPlaywrightReapResult,
  reapStalePlaywrightProcesses,
} from "../core/playwright-watchdog.mjs";
import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { detectPaneStatus } from "../cli/format.mjs";

export function createPlaywrightWatchdog({
  agent,
  deliveryBroker = null,
  agentsYamlPath,
  discord,
  config,
  log = (msg) => console.log(`playwright-watchdog | ${msg}`),
  reap = reapStalePlaywrightProcesses,
}) {
  const seen = new Map();
  const escaped = new Map();
  let intervalId = null;

  async function post(agentName, paneIdx, text) {
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) return;
    try {
      await discord.send(channelId, text);
    } catch (err) {
      log(`discord send failed for ${agentName}:${paneIdx}: ${err.message}`);
    }
  }

  async function inspectPane(agentConfig, paneIdx, now) {
    const paneKey = `${agentConfig.name}:${paneIdx}`;
    let content = "";
    try {
      content = await agent.capturePane(agentConfig.name, paneIdx, 120);
    } catch {
      seen.delete(paneKey);
      escaped.delete(paneKey);
      return;
    }

    const status = detectPaneStatus(content);
    const signature = detectActivePlaywrightTool(content, status);

    if (!signature) {
      seen.delete(paneKey);
      escaped.delete(paneKey);
      return;
    }

    const prev = seen.get(paneKey);
    if (!prev || prev.signature !== signature) {
      seen.set(paneKey, { signature, firstSeenAt: now });
      escaped.delete(paneKey);
      return;
    }

    const age = now - prev.firstSeenAt;
    if (age < config.toolTimeoutMs || escaped.get(paneKey) === signature) return;

    escaped.set(paneKey, signature);
    try {
      if (deliveryBroker) {
        await deliveryBroker.runExclusive(agentConfig.name, paneIdx, () =>
          agent.sendEscape(agentConfig.name, paneIdx));
      } else {
        await agent.sendEscape(agentConfig.name, paneIdx);
      }
      log(`sent Escape to ${paneKey}; Playwright tool stalled for ${Math.round(age / 1000)}s`);
      await post(
        agentConfig.name,
        paneIdx,
        `Playwright watchdog: avbröt en MCP-browsercall i ${paneKey} efter ${Math.round(age / 1000)}s. Försök gärna ta bilden igen.`,
      );
    } catch (err) {
      log(`Escape failed for ${paneKey}: ${err.message}`);
    }
  }

  async function tick() {
    if (!config.enabled) return;

    const reapResult = reap({ maxAgeMs: config.mcpMaxAgeMs });
    if (reapResult.candidates > 0) log(formatPlaywrightReapResult(reapResult));

    let agents;
    try {
      agents = listAgents(agentsYamlPath);
    } catch {
      return;
    }

    const now = Date.now();
    for (const a of agents) {
      if (a.backend === "native") continue;
      const panes = Array.isArray(a.panes) ? a.panes : [];
      for (let i = 0; i < panes.length; i++) {
        await inspectPane(a, i, now);
      }
    }
  }

  function start() {
    if (!config.enabled) {
      log("disabled (AMUX_PLAYWRIGHT_WATCHDOG_ENABLED=false)");
      return;
    }
    if (intervalId) return;
    log(`enabled | tool-timeout=${Math.round(config.toolTimeoutMs / 1000)}s mcp-max-age=${Math.round(config.mcpMaxAgeMs / 60_000)}m poll=${Math.round(config.pollMs / 1000)}s`);
    tick().catch((err) => log(`initial tick failed: ${err.message}`));
    intervalId = setInterval(() => {
      tick().catch((err) => log(`tick failed: ${err.message}`));
    }, config.pollMs);
  }

  function stop() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  return { start, stop, tick };
}
