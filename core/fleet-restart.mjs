// Durable handoff for a full agentmux fleet restart.
//
// The requesting CLI may itself run inside a tmux session that will be
// destroyed. It therefore cannot kill and recreate the fleet synchronously.
// Instead it writes this one-shot request, asks the supervised bridge to
// restart, and the replacement bridge performs the rebuild from outside all
// configured coding sessions.

import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { dirname, join } from "path";

export const FLEET_RESTART_RESULT_KEY = "fleetRestartResult";

export function fleetRestartRequestPath(env = process.env) {
  return env.AMUX_FLEET_RESTART_REQUEST
    || join(env.HOME || "/tmp", ".agentmux", "fleet-restart-request.json");
}

/** Queue one restart request atomically; no credentials or pane content. */
export function queueFleetRestart({ source = "cli", requestedAt = new Date().toISOString(), path = null } = {}) {
  const requestPath = path || fleetRestartRequestPath();
  const request = { version: 1, source, requestedAt };
  mkdirSync(dirname(requestPath), { recursive: true, mode: 0o700 });
  const temp = `${requestPath}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(request) + "\n", { mode: 0o600 });
  renameSync(temp, requestPath);
  return request;
}

/** Read-and-delete receipt: one bridge generation owns each request once. */
export function consumeFleetRestart({ path = null } = {}) {
  const requestPath = path || fleetRestartRequestPath();
  let request;
  try {
    request = JSON.parse(readFileSync(requestPath, "utf-8"));
  } catch {
    try { unlinkSync(requestPath); } catch {}
    return null;
  }
  try { unlinkSync(requestPath); } catch {}
  if (request?.version !== 1 || !["cli", "discord"].includes(request.source)) return null;
  return request;
}

/** Execute a pending request and persist a compact startup/Discord receipt. */
export async function runPendingFleetRestart({ agent, state, path = null, log = console.log } = {}) {
  const request = consumeFleetRestart({ path });
  if (!request) return null;

  log(`fleet restart requested by ${request.source} at ${request.requestedAt}`);
  let fleet;
  try {
    fleet = await agent.restartFleet({ log });
  } catch (err) {
    fleet = {
      ok: false,
      configured: [],
      stopped: [],
      recreated: [],
      codingPanes: 0,
      failures: [{ name: "fleet", stage: "run", error: err.message }],
    };
  }
  const receipt = {
    ...fleet,
    source: request.source,
    requestedAt: request.requestedAt,
    completedAt: new Date().toISOString(),
  };
  state?.set?.(FLEET_RESTART_RESULT_KEY, receipt);
  log(formatFleetRestartResult(receipt));
  return receipt;
}

export function formatFleetRestartResult(result) {
  if (!result) return "online";
  const base = `${result.recreated?.length || 0}/${result.configured?.length || 0} tmux-sessioner, ${result.codingPanes || 0} agentpaneler`;
  if (result.ok) return `online · helreset klar: ${base}`;
  const failed = (result.failures || [])
    .slice(0, 5)
    .map((item) => `${item.name} (${item.stage})`)
    .join(", ");
  return `⚠️ online · helreset delvis klar: ${base}${failed ? ` · fel: ${failed}` : ""}`;
}
