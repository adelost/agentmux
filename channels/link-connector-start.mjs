// Bridge-side starter for the outbound Link connector. Off unless both the
// base URL and the connector credential are configured.

import { homedir } from "node:os";
import { join } from "node:path";
import { runLinkConnectorCycle } from "./link-connector.mjs";

/** WHAT: Schedules the Link connector poll loop when configured. WHY: Keeps index.mjs free of connector wiring detail. */
export function startLinkConnectorIfConfigured({ agent, deliveryBroker, log = console.log, error = console.error } = {}) {
  if (!process.env.LINK_BASE || !process.env.LINK_TOKEN_WSL) return false;
  const targets = String(process.env.LINK_TARGETS_WSL || "lsrc:3,lsrc:10")
    .split(",").map((value) => value.trim()).filter(Boolean);
  const statePath = join(homedir(), ".agentmux", "link-connector.json");
  const cycle = () => runLinkConnectorCycle({
    linkBase: process.env.LINK_BASE,
    token: process.env.LINK_TOKEN_WSL,
    targets,
    agent,
    deliveryBroker,
    statePath,
    log,
  }).catch((cycleError) => error(`link-connector | cycle failed: ${cycleError.message}`));
  setTimeout(() => {
    void cycle();
    setInterval(cycle, 15_000);
  }, 20_000);
  log(`link-connector | enabled | base=${process.env.LINK_BASE} targets=${targets.join(",")}`);
  return true;
}
