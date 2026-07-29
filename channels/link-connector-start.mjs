// Bridge-side starter for the outbound Link connector. Off unless both the
// base URL and the connector credential are configured.

import { homedir } from "node:os";
import { join } from "node:path";
import { runLinkConnectorCycle } from "./link-connector.mjs";
import { createVoiceBufferTranscriber } from "../core/voice-transcriber.mjs";

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
  scheduleInterval = setInterval,
} = {}) {
  if (!process.env.LINK_BASE || !process.env.LINK_TOKEN_WSL) return false;
  const voiceTranscriber = transcribe || createVoiceBufferTranscriber({
    run,
    transcribeScript,
  });
  const targets = String(process.env.LINK_TARGETS_WSL || "lsrc:3,lsrc:10")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const statePath = join(homedir(), ".agentmux", "link-connector.json");
  const cycle = () => runCycle({
    linkBase: process.env.LINK_BASE,
    token: process.env.LINK_TOKEN_WSL,
    targets,
    agent,
    deliveryBroker,
    deliveryQueue,
    transcribe: voiceTranscriber,
    statePath,
    log,
  }).catch((cycleError) => error(`link-connector | cycle failed: ${cycleError.message}`));
  scheduleTimeout(() => {
    void cycle();
    scheduleInterval(cycle, 15_000);
  }, 20_000);
  log(`link-connector | enabled | base=${process.env.LINK_BASE} targets=${targets.join(",")}`);
  return true;
}
