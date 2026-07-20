// Atomic fleet stop: the 2026-07-20 incident killed every session and only
// then crashed on the bridge stop, leaving the fleet half-stopped. The
// bridge is stopped FIRST; a refusal or timeout aborts before any session
// kill, so the worst case is nothing stopped, never partially destroyed.

/** WHAT: Builds the atomic fleet stop over injected seams. WHY: Keeps stop order provable without a live fleet. */
export function createStopAll({ listAgents, hasSession, killSession, stopBridge }) {
  /** WHAT: Stops the bridge, then every planned session. WHY: Prevents a bridge refusal from becoming partial destruction. */
  return async function stopAll(ctx) {
    const agents = listAgents(ctx.configPath);
    const plan = [];
    for (const a of agents) {
      if (a.backend === "native") continue;
      if (await hasSession(ctx, a.name)) plan.push(a.name);
    }
    const bridgeStopped = await stopBridge(ctx);
    for (const name of plan) await killSession(ctx, name);
    if (bridgeStopped) plan.push("bridge");
    return plan;
  };
}
