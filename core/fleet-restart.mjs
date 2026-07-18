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
  if (request?.version !== 1 || !["cli", "discord", "watchdog"].includes(request.source)) return null;
  return request;
}

/** WHAT: Routes one pending fleet restart. WHY: Keeps destructive restarts outside configured agent sessions. */
export async function runPendingFleetRestart({
  agent, state, path = null, log = console.log, enqueueContinuation = null,
} = {}) {
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
  if (typeof enqueueContinuation === "function") {
    for (const target of fleet.resumeTargets || []) {
      try {
        enqueueContinuation({
          agentName: target.agentName,
          pane: target.pane,
          text: "[AMUX AUTOMATIC CRASH RECOVERY · SAME SESSION]\n" +
            "Fortsätt den avbrutna uppgiften från den återupptagna sammanfattningen. " +
            "Kontrollera först vad som redan hann bli gjort och duplicera inget.",
          source: "fleet-restart-recovery",
          idempotencyKey: `fleet-restart:${request.requestedAt}:${target.agentName}:${target.pane}:${target.sessionId}`,
          metadata: {
            recoveredSessionId: target.sessionId,
            recoveredDialect: target.dialect,
          },
        });
      } catch (err) {
        fleet.failures = fleet.failures || [];
        fleet.failures.push({
          name: `${target.agentName}:${target.pane}`,
          stage: "continuation",
          error: err.message,
        });
        fleet.ok = false;
      }
    }
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

/** WHAT: Formats one fleet restart receipt. WHY: Keeps startup reporting compact and free from private error details. */
export function formatFleetRestartResult(result) {
  if (!result) return "online";
  const base = `${result.recreated?.length || 0}/${result.configured?.length || 0} tmux-sessioner, ${result.codingPanes || 0} agentpaneler` +
    `${result.resumeTargets?.length ? `, ${result.resumeTargets.length} avbrutna turns återköade` : ""}`;
  if (result.ok) return `online · helreset klar: ${base}`;
  const failed = (result.failures || [])
    .slice(0, 5)
    .map((item) => `${item.name} (${item.stage})`)
    .join(", ");
  return `⚠️ online · helreset delvis klar: ${base}${failed ? ` · fel: ${failed}` : ""}`;
}
