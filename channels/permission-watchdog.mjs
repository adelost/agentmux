import { classifyPermissionPrompt, detectPermissionPrompt, formatPermissionAlert } from "../core/permission-watchdog.mjs";
import { listAgents, findChannelForPane } from "../cli/config.mjs";

/**
 * WHAT: Watches every tmux pane for a Claude Code permission prompt that has
 * blocked it for longer than config.promptAgeMs, answers the one provably
 * harmless pattern itself and alerts the human about every other one.
 * WHY: A pane cannot answer its own prompt; without this nothing in amux
 * noticed a paid run sitting behind a rm confirmation for 21 minutes.
 */
export function createPermissionWatchdog({
  agent,
  deliveryBroker = null,
  agentsYamlPath,
  discord,
  config,
  notifyUser = null,
  log = (msg) => console.log(`permission-watchdog | ${msg}`),
  now = Date.now,
}) {
  const seen = new Map();     // paneKey -> { signature, firstSeenAt }
  const handled = new Map();  // paneKey -> signature already answered/alerted
  let intervalId = null;

  async function post(agentName, paneIdx, text) {
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) return;
    try { await discord.send(channelId, text); } catch (err) { log(`discord send failed for ${agentName}:${paneIdx}: ${err.message}`); }
  }

  async function answer(agentName, paneIdx, keys) {
    const run = async () => {
      await agent.typeLiteral(agentName, keys, paneIdx);
      await agent.sendEnter(agentName, paneIdx);
    };
    if (deliveryBroker) await deliveryBroker.runExclusive(agentName, paneIdx, run);
    else await run();
  }

  async function inspectPane(agentConfig, paneIdx, at) {
    const paneKey = `${agentConfig.name}:${paneIdx}`;
    let content = "";
    try {
      content = await agent.capturePane(agentConfig.name, paneIdx, 120);
    } catch {
      seen.delete(paneKey); handled.delete(paneKey);
      return null;
    }
    // detectPermissionPrompt is the gate on its own: it requires the question,
    // its numbered options and "Esc to cancel" in the last lines with no
    // composer below, so a footer-less capture is still recognised.
    const prompt = detectPermissionPrompt(content);
    if (!prompt) { seen.delete(paneKey); handled.delete(paneKey); return null; }

    const prev = seen.get(paneKey);
    if (!prev || prev.signature !== prompt.signature) {
      seen.set(paneKey, { signature: prompt.signature, firstSeenAt: at });
      handled.delete(paneKey);
      return null;
    }
    const ageMs = at - prev.firstSeenAt;
    if (ageMs < config.promptAgeMs || handled.get(paneKey) === prompt.signature) return null;
    handled.set(paneKey, prompt.signature);

    const decision = classifyPermissionPrompt(prompt);
    if (decision.action === "answer" && config.autoAnswer) {
      try {
        await answer(agentConfig.name, paneIdx, decision.keys);
        log(`answered "${decision.keys}" in ${paneKey} after ${Math.round(ageMs / 1000)}s: ${decision.why}`);
        await post(agentConfig.name, paneIdx, `Permission watchdog: svarade ja i ${paneKey} efter ${Math.round(ageMs / 60_000)} min. ${decision.why}. Skäl i frågan: ${prompt.reason}`);
        return { paneKey, action: "answered" };
      } catch (err) {
        log(`answer failed for ${paneKey}: ${err.message}`);
      }
    }
    const text = formatPermissionAlert({ paneKey, ageMs, reason: prompt.reason, command: prompt.command, why: decision.action === "answer" ? "auto-svar avstängt" : decision.why });
    log(`alert for ${paneKey}: ${decision.why}`);
    await post(agentConfig.name, paneIdx, text);
    if (notifyUser) {
      try { await notifyUser(text, { idempotencyKey: `permission-watchdog:${paneKey}:${prompt.signature.slice(0, 80)}` }); }
      catch (err) { log(`notifyUser failed for ${paneKey}: ${err.message}`); }
    }
    return { paneKey, action: "alerted" };
  }

  async function tick() {
    if (!config.enabled) return [];
    let agents;
    try { agents = listAgents(agentsYamlPath); } catch { return []; }
    const at = now();
    const results = [];
    for (const a of agents) {
      if (a.backend === "native") continue;
      const panes = Array.isArray(a.panes) ? a.panes : [];
      for (let i = 0; i < panes.length; i++) {
        const r = await inspectPane(a, i, at);
        if (r) results.push(r);
      }
    }
    return results;
  }

  function start() {
    if (!config.enabled) { log("disabled (AMUX_PERMISSION_WATCHDOG_ENABLED=false)"); return; }
    if (intervalId) return;
    log(`enabled | prompt-age=${Math.round(config.promptAgeMs / 1000)}s poll=${Math.round(config.pollMs / 1000)}s auto-answer=${config.autoAnswer}`);
    tick().catch((err) => log(`initial tick failed: ${err.message}`));
    intervalId = setInterval(() => { tick().catch((err) => log(`tick failed: ${err.message}`)); }, config.pollMs);
  }

  function stop() { if (intervalId) { clearInterval(intervalId); intervalId = null; } }

  return { start, stop, tick };
}
