// Bot lifecycle: singleton lock, channel management, config, preflight, shutdown.
// Channel-agnostic — receives channels array, delegates messaging to them.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { buildChannelMap } from "./lib.mjs";

const PIDFILE = process.env.PIDFILE || "/tmp/agentmux.pid";

function ensureSingleInstance() {
  if (existsSync(PIDFILE)) {
    const oldPid = readFileSync(PIDFILE, "utf-8").trim();
    try {
      process.kill(Number(oldPid), 0);
      console.error(`Already running (pid ${oldPid}). Kill it first or remove ${PIDFILE}`);
      process.exit(1);
    } catch {}
  }
  writeFileSync(PIDFILE, String(process.pid));
}

/**
 * Start the bot with one or more channels.
 * @param {{ channels: import('./channels/channel.mjs').Channel[], agentsYaml, whisperUrl, agent, tts, state, onMessage }} config
 */
export function startBot({ channels, agentsYaml, whisperUrl, agent, tts, state, onMessage }) {
  ensureSingleInstance();

  // --- Channel map ---

  let channelMap = loadChannelMap(agentsYaml);
  const overrides = new Map();

  // Restore persisted overrides
  const saved = state.get("overrides", {});
  for (const [chId, mapping] of Object.entries(saved)) overrides.set(chId, mapping);

  function getMapping(channelId) {
    return overrides.get(channelId) || channelMap.get(channelId);
  }

  function reloadConfig() {
    channelMap = loadChannelMap(agentsYaml);
    overrides.clear();
    console.log(`Reloaded: ${channelMap.size} channel mapping(s)`);
    for (const [chId, { name }] of channelMap) console.log(`  ${name} -> ${chId}`);
  }

  process.on("SIGHUP", reloadConfig);

  // --- Preflight ---

  async function preflight() {
    for (const [channelId, { name }] of channelMap) {
      try {
        await agent.checkAgent(name);
        console.log(`  ${name} -> #${channelId} [ok]`);
      } catch {
        console.warn(`  ${name} -> #${channelId} [not running]`);
      }
    }
    try {
      await fetch(whisperUrl.replace("/transcriptions", ""));
      console.log(`  whisper -> ${whisperUrl} [ok]`);
    } catch {
      console.warn(`  whisper -> not reachable (voice disabled)`);
    }
  }

  // --- Start channels ---

  for (const channel of channels) {
    channel.onMessage(onMessage);
  }

  (async () => {
    const ttsLabel = tts.isEnabled() ? ` | tts: ${tts.voice}` : "";
    for (const channel of channels) {
      const info = await channel.start();
      const userLabel = info?.user ? ` | ${info.user}` : "";
      console.log(`${channel.name} | ${channelMap.size} channel(s)${ttsLabel}${userLabel}`);
    }
    for (const [chId, { name }] of channelMap) console.log(`  ${name} -> #${chId}`);
    await preflight();

    // Notify restart channel if we came back from /restart
    const restartCh = state.get("restartChannel");
    console.log(`restart check: ${restartCh || "(none)"}`);
    if (restartCh) {
      state.set("restartChannel", null);
      // Small delay to ensure Discord connection is fully ready
      await new Promise((r) => setTimeout(r, 2000));
      for (const channel of channels) {
        try {
          await channel.send(restartCh, "online");
          console.log(`restart notify sent to ${restartCh}`);
        } catch (err) { console.error("restart notify failed:", err.message); }
      }
    }
  })();

  // --- Heartbeat ---

  let shuttingDown = false;
  let failCount = 0;
  const HEARTBEAT_INTERVAL = 30_000;
  const MAX_FAILURES = 3; // 3 consecutive failures (~90s) before restart

  const heartbeat = setInterval(() => {
    if (shuttingDown) return;
    const alive = channels.every((ch) => !ch.isAlive || ch.isAlive());
    if (alive) {
      failCount = 0;
      return;
    }
    failCount++;
    console.warn(`[heartbeat] channel unhealthy (${failCount}/${MAX_FAILURES})`);
    if (failCount >= MAX_FAILURES) {
      console.error(`[heartbeat] ${MAX_FAILURES} consecutive failures, exiting for restart`);
      try { unlinkSync(PIDFILE); } catch {}
      process.exit(1);
    }
  }, HEARTBEAT_INTERVAL);

  // --- Shutdown ---

  const shutdown = () => {
    shuttingDown = true;
    clearInterval(heartbeat);
    console.log("\nShutting down...");
    try { unlinkSync(PIDFILE); } catch {}
    for (const channel of channels) channel.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { getMapping, overrides, channelMap: () => channelMap, reloadConfig };
}

function loadChannelMap(agentsYaml) {
  try {
    return buildChannelMap(readFileSync(agentsYaml, "utf-8"));
  } catch (err) {
    console.error(`Failed to read ${agentsYaml}: ${err.message}`);
    return new Map();
  }
}
