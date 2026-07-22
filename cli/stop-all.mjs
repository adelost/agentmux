// Atomic fleet stop: the 2026-07-20 incident killed every session and only
// then crashed on the bridge stop, leaving the fleet half-stopped. The
// bridge is stopped FIRST; a refusal or timeout aborts before any session
// kill, so the worst case is nothing stopped, never partially destroyed.

import { listAgents } from "./config.mjs";
import { hasSession, killSession } from "./tmux.mjs";
import { collectStopRecoveryCandidates, recordStopRecovery } from "./stop-recovery.mjs";

/** WHAT: Builds the atomic fleet stop over injected seams. WHY: Keeps stop order provable without a live fleet. */
export function createStopAll({
  listAgents,
  hasSession,
  killSession,
  stopBridge,
  collectRecoveryCandidates = async () => [],
  recordRecovery = () => null,
}) {
  /** WHAT: Stops the bridge, then every planned session. WHY: Prevents a bridge refusal from becoming partial destruction. */
  return async function stopAll(ctx) {
    const agents = listAgents(ctx.configPath);
    const plan = [];
    for (const a of agents) {
      if (a.backend === "native") continue;
      if (await hasSession(ctx, a.name)) plan.push(a.name);
    }
    const recovery = await collectRecoveryCandidates(ctx, agents, plan);
    const bridgeStopped = await stopBridge(ctx);
    recordRecovery(recovery);
    for (const name of plan) await killSession(ctx, name);
    if (bridgeStopped) plan.push("bridge");
    return { stopped: plan, recovery };
  };
}

/** WHAT: Dispatches and reports one deliberate fleet stop. WHY: Keeps recovery inventory and terminal output outside the command router. */
export async function runStopAll(ctx, stopBridge) {
  const result = await createStopAll({
    listAgents,
    hasSession,
    killSession,
    stopBridge,
    collectRecoveryCandidates: collectStopRecoveryCandidates,
    recordRecovery: recordStopRecovery,
  })(ctx);
  if (!result.stopped.length) console.log("Nothing to stop.");
  else console.log(`Stopped: ${result.stopped.join(", ")}.`);
  if (result.recovery.length) {
    console.log(`Recovery receipt: ${result.recovery.length} unfinished pane(s); after serve run 'amux revive'.`);
  }
  return result;
}
