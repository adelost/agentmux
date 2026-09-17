// Bridge-side starter for the outbound Link connector. Off unless both the
// base URL and the connector credential are configured.

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import yaml from "js-yaml";
import { runLinkConnectorCycle } from "./link-connector.mjs";
import { phoneTargets } from "./audio-targets.mjs";
import { createVoiceBufferTranscriber } from "../core/voice-transcriber.mjs";
import { normalizeServiceBaseUrl } from "../core/runtime-defaults.mjs";

/** WHAT: Builds the target list the connector announces. WHY: The phone should
 *  reach every pane the fleet maps to a channel, with the configured ids as the
 *  floor, and read fresh so a relabelled pane needs no restart (row 184). */
export function announcedLinkTargets({ seed, agentsYamlPath, audioDiscovery }) {
  const targets = seed.map((id) => ({ id, label: id }));
  const byId = new Map(targets.map((target) => [target.id, target]));
  let agents = {};
  if (agentsYamlPath && existsSync(agentsYamlPath)) {
    try { agents = yaml.load(readFileSync(agentsYamlPath, "utf-8")) || {}; }
    catch { agents = {}; }
  }
  for (const target of phoneTargets(audioDiscovery, agents)) {
    const known = byId.get(target.id);
    // A seeded id keeps its place and gains the pane's own label.
    if (known) { known.label = target.label; continue; }
    const entry = { id: target.id, label: target.label };
    byId.set(entry.id, entry);
    targets.push(entry);
  }
  return targets;
}

/** WHAT: Schedules the Link connector poll loop when configured. WHY: Keeps index.mjs free of connector wiring detail. */
export function startLinkConnectorIfConfigured({
  agent,
  deliveryBroker,
  deliveryQueue,
  transcribe,
  run,
  transcribeScript,
  log = console.log,
  error = console.error,
  runCycle = runLinkConnectorCycle,
  scheduleTimeout = setTimeout,
  agentsYamlPath = null,
  audioDiscovery = null,
} = {}) {
  if (!process.env.LINK_BASE || !process.env.LINK_TOKEN_WSL) return false;
  if (!process.env.LINK_TARGETS_WSL) {
    throw new Error("Link connector requires explicit LINK_TARGETS_WSL");
  }
  const voiceTranscriber = transcribe || createVoiceBufferTranscriber({
    run,
    transcribeScript,
  });
  const seed = String(process.env.LINK_TARGETS_WSL)
    .split(",").map((value) => value.trim()).filter(Boolean);
  const targets = () => announcedLinkTargets({ seed, agentsYamlPath, audioDiscovery });
  const linkBase = normalizeServiceBaseUrl(process.env.LINK_BASE, "Link base URL", {
    allowHttpLoopback: true,
  });
  const statePath = join(homedir(), ".agentmux", "link-connector.json");
  const cycle = async () => {
    try {
      await runCycle({
        linkBase,
        token: process.env.LINK_TOKEN_WSL,
        targets,
        agent,
        deliveryBroker,
        deliveryQueue,
        transcribe: voiceTranscriber,
        statePath,
        log,
      });
    } catch (cycleError) {
      error(`link-connector | cycle failed: ${cycleError.message}`);
    } finally {
      scheduleTimeout(cycle, 15_000);
    }
  };
  scheduleTimeout(cycle, 20_000);
  log(`link-connector | enabled | base=${linkBase} targets=${targets().map((target) => target.id).join(",")}`);
  return true;
}
