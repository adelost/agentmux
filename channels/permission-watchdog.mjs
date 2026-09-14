import { classifyPermissionPrompt, detectPermissionPrompt, formatPermissionAlert } from "../core/permission-watchdog.mjs";
import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";

/**
 * WHAT: Checks whether git keeps a file at or under a literal rm prefix.
 * WHY: Keeps tracked and uncommitted work from auto-approved deletes.
 */
export function gitKeepsFilesUnder(path) {
  // Kept means tracked, or untracked and not ignored. Outside a repository git
  // knows nothing; any other git failure counts as kept, so unknown never deletes.
  let dir = path;
  while (dir !== "/" && !existsSync(dir)) dir = dirname(dir);
  // A folder means its contents; anything else is a name prefix ("2026-09-1*").
  const spec = dir === path && statSync(path).isDirectory() ? `${path}/` : `${path}*`;
  try {
    const out = execFileSync("git", ["-C", dir, "ls-files", "--cached", "--others", "--exclude-standard", "--", spec], { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1 << 20 });
    return out.trim().length > 0;
  } catch (err) {
    if (err.code === "ENOBUFS") return true;
    return !/not a git repository/u.test(String(err.stderr || ""));
  }
}

/**
 * WHAT: Schedules pane scans that answer safe rm prompts and alert on the rest.
 * WHY: Keeps a pane from waiting on a prompt it cannot answer itself.
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
  home = homedir(),
  holdsKeptFiles = gitKeepsFilesUnder,
}) {
  // Safe rm prompts are answered after config.answerAgeMs, every other prompt
  // alerts the human after config.promptAgeMs.
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
    if (handled.get(paneKey) === prompt.signature) return null;
    const decision = classifyPermissionPrompt(prompt, { home, holdsKeptFiles });
    const answerable = decision.action === "answer" && config.autoAnswer;
    if (ageMs < (answerable ? config.answerAgeMs : config.promptAgeMs)) return null;
    handled.set(paneKey, prompt.signature);

    if (answerable) {
      try {
        await answer(agentConfig.name, paneIdx, decision.keys);
        log(`answered "${decision.keys}" in ${paneKey} after ${Math.round(ageMs / 1000)}s: ${decision.why}`);
        await post(agentConfig.name, paneIdx, `Permission watchdog: svarade ja i ${paneKey} efter ${Math.round(ageMs / 1000)} s. ${decision.why}. Skäl i frågan: ${prompt.reason}`);
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
    log(`enabled | answer-age=${Math.round(config.answerAgeMs / 1000)}s prompt-age=${Math.round(config.promptAgeMs / 1000)}s poll=${Math.round(config.pollMs / 1000)}s auto-answer=${config.autoAnswer}`);
    tick().catch((err) => log(`initial tick failed: ${err.message}`));
    intervalId = setInterval(() => { tick().catch((err) => log(`tick failed: ${err.message}`)); }, config.pollMs);
  }

  function stop() { if (intervalId) { clearInterval(intervalId); intervalId = null; } }

  return { start, stop, tick };
}
