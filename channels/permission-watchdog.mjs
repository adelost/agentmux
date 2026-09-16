import {
  classifyPermissionPrompt,
  detectPermissionPrompt,
  formatPermissionAlert,
  nextPromptStep,
  openPromptsSnapshot,
  permissionDecisionLine,
} from "../core/permission-watchdog.mjs";
import { listAgents, findChannelForPane } from "../cli/config.mjs";
import { latestClaudeSessionIdentity } from "../core/native-session-identity.mjs";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
 * WHAT: Resolves the file that records every watchdog decision.
 * WHY: Keeps "did it answer?" answerable without the bridge's own terminal.
 */
export function permissionDecisionLogPath(env = process.env, home = homedir()) {
  return env.AMUX_PERMISSION_WATCHDOG_LOG || join(home, ".agentmux", "permission-watchdog.jsonl");
}

/**
 * WHAT: Resolves the file that holds the prompts blocking panes right now.
 * WHY: Keeps `amux prompts` able to show how long a pane has waited.
 */
export function openPromptsPath(env = process.env, home = homedir()) {
  return env.AMUX_PERMISSION_PROMPTS_PATH || join(home, ".agentmux", "permission-prompts.json");
}

function writeFile(path, text, { append }) {
  mkdirSync(dirname(path), { recursive: true });
  if (append) appendFileSync(path, text);
  else writeFileSync(path, text);
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
  recordDecision = (line) => writeFile(permissionDecisionLogPath(), line, { append: true }),
  publishOpenPrompts = (text) => writeFile(openPromptsPath(), text, { append: false }),
  sessionIdentity = (agentConfig, paneIdx) => {
    const paneDir = agent.paneDirectory(agentConfig.dir, paneIdx);
    return latestClaudeSessionIdentity(paneDir)?.sessionId || null;
  },
}) {
  // Safe rm prompts are answered after config.answerAgeMs, every other prompt
  // alerts the human after config.promptAgeMs.
  const seen = new Map();
  let intervalId = null;
  let publishedPrompts = null;

  async function post(agentName, paneIdx, text) {
    const channelId = findChannelForPane(agentsYamlPath, agentName, paneIdx);
    if (!channelId || !discord) return;
    try { await discord.send(channelId, text); } catch (err) { log(`discord send failed for ${agentName}:${paneIdx}: ${err.message}`); }
  }

  async function answerIfCurrent(agentConfig, paneIdx, expected, state, keys) {
    const run = async () => {
      const content = await agent.capturePane(agentConfig.name, paneIdx, 120);
      const current = detectPermissionPrompt(content);
      const currentSessionId = sessionIdentity(agentConfig, paneIdx);
      if (!current || current.signature !== expected.signature
          || !currentSessionId || currentSessionId !== expected.sessionId) return false;
      state.answered = true;
      await agent.typeLiteral(agentConfig.name, keys, paneIdx);
      await agent.sendEnter(agentConfig.name, paneIdx);
      return true;
    };
    return deliveryBroker
      ? deliveryBroker.runExclusive(agentConfig.name, paneIdx, run)
      : run();
  }

  async function routeToOrchestrator(agentConfig, paneIdx, prompt, ageMs) {
    const ownerPane = agentConfig.orchestrator;
    const text = formatPermissionAlert({
      paneKey: `${agentConfig.name}:${paneIdx}`,
      ageMs,
      reason: prompt.reason,
      command: prompt.command,
      why: "kräver ägarbeslut",
    });
    await agent.sendOnly(agentConfig.name, text, ownerPane);
  }

  async function inspectPane(agentConfig, paneIdx, at) {
    const paneKey = `${agentConfig.name}:${paneIdx}`;
    let content = "";
    try {
      content = await agent.capturePane(agentConfig.name, paneIdx, 120);
    } catch {
      seen.delete(paneKey);
      return null;
    }
    // detectPermissionPrompt is the gate on its own: it requires the question,
    // its numbered options and "Esc to cancel" in the last lines with no
    // composer below, so a footer-less capture is still recognised.
    const prompt = detectPermissionPrompt(content);
    if (!prompt) { seen.delete(paneKey); return null; }
    const sessionId = sessionIdentity(agentConfig, paneIdx);

    const prev = seen.get(paneKey);
    if (!prev || prev.signature !== prompt.signature || prev.sessionId !== sessionId) {
      seen.set(paneKey, {
        signature: prompt.signature,
        sessionId,
        reason: prompt.reason,
        decision: null,
        firstSeenAt: at,
        answered: false,
        orchestratorNotified: false,
        humanNotified: false,
      });
      return null;
    }
    const ageMs = at - prev.firstSeenAt;
    const decision = classifyPermissionPrompt(prompt, { home, holdsKeptFiles });
    prev.decision = decision.action === "answer" ? "auto-answer" : `needs-owner: ${decision.why}`;
    const decided = (action, why) => {
      try {
        recordDecision(permissionDecisionLine({
          at, paneKey, sessionId: prev.sessionId, signature: prompt.signature, action, reason: prompt.reason, why,
        }));
      } catch (err) {
        log(`decision log write failed for ${paneKey}: ${err.message}`);
      }
      return { paneKey, action };
    };
    const answerable = decision.action === "answer" && config.autoAnswer && Boolean(prev.sessionId);
    const ownerPane = agentConfig.orchestrator;
    const hasOrchestrator = Number.isSafeInteger(ownerPane)
      && ownerPane >= 0
      && ownerPane < agentConfig.panes.length
      && ownerPane !== paneIdx
      && typeof agent.sendOnly === "function";
    const step = nextPromptStep({ ageMs, answerable, hasOrchestrator, state: prev, config });
    if (!step) return null;

    if (step === "answer") {
      try {
        const answered = await answerIfCurrent(agentConfig, paneIdx, prev, prev, decision.keys);
        if (!answered) {
          seen.delete(paneKey);
          log(`stale prompt refused in ${paneKey}: session or signature changed before answer`);
          return decided("stale", "session or signature changed before the answer");
        }
        log(`answered "${decision.keys}" in ${paneKey} after ${Math.round(ageMs / 1000)}s: ${decision.why}`);
        await post(agentConfig.name, paneIdx, `Permission watchdog: svarade ja i ${paneKey} efter ${Math.round(ageMs / 1000)} s. ${decision.why}. Skäl i frågan: ${prompt.reason}`);
        return decided("answered", decision.why);
      } catch (err) {
        log(`answer failed for ${paneKey}: ${err.message}`);
        return decided("answer-uncertain", err.message);
      }
    }

    if (step === "orchestrator") {
      prev.orchestratorNotified = true;
      try {
        await routeToOrchestrator(agentConfig, paneIdx, prompt, ageMs);
        log(`routed prompt ${prompt.signature.slice(0, 12)} from ${paneKey} to ${agentConfig.name}:${ownerPane}`);
        return decided("escalated-orchestrator", `${agentConfig.name}:${ownerPane} owns the decision`);
      } catch (err) {
        log(`orchestrator route failed for ${paneKey}: ${err.message}`);
      }
    }

    prev.humanNotified = true;
    const text = formatPermissionAlert({ paneKey, ageMs, reason: prompt.reason, command: prompt.command, why: decision.action === "answer" ? "auto-svar avstängt" : decision.why });
    log(`alert for ${paneKey}: ${decision.why}`);
    await post(agentConfig.name, paneIdx, text);
    if (notifyUser) {
      try { await notifyUser(text, { idempotencyKey: `permission-watchdog:${paneKey}:${prompt.signature.slice(0, 80)}` }); }
      catch (err) { log(`notifyUser failed for ${paneKey}: ${err.message}`); }
    }
    return decided("escalated-human", decision.action === "answer" ? "auto-svar avstängt" : decision.why);
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
    publishOpen(at);
    return results;
  }

  function publishOpen(at) {
    const open = [...seen.entries()].map(([paneKey, state]) => ({ paneKey, ...state }));
    const text = openPromptsSnapshot(at, open);
    const shape = text.replace(/"ts": "[^"]*"/u, "");
    if (shape === publishedPrompts) return;
    try {
      publishOpenPrompts(text);
      publishedPrompts = shape;
    } catch (err) {
      log(`open-prompt snapshot write failed: ${err.message}`);
    }
  }

  function start() {
    if (!config.enabled) { log("disabled (AMUX_PERMISSION_WATCHDOG_ENABLED=false)"); return; }
    if (intervalId) return;
    log(`enabled | answer-age=${Math.round(config.answerAgeMs / 1000)}s prompt-age=${Math.round(config.promptAgeMs / 1000)}s human-age=${Math.round(config.humanAgeMs / 1000)}s poll=${Math.round(config.pollMs / 1000)}s auto-answer=${config.autoAnswer}`);
    tick().catch((err) => log(`initial tick failed: ${err.message}`));
    intervalId = setInterval(() => { tick().catch((err) => log(`tick failed: ${err.message}`)); }, config.pollMs);
  }

  function stop() { if (intervalId) { clearInterval(intervalId); intervalId = null; } }

  return { start, stop, tick };
}
