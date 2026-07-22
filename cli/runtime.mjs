// Native runtime lifecycle CLI. Configured endpoints remain visible even when
// they have no local process receipt; managed but unconfigured instances are
// listed separately.

import { resolve } from "node:path";
import { listAgents } from "./config.mjs";
import {
  checkNativeRuntimeHealth,
  discoverNativeRuntimes,
  formatNativeRuntimeStatuses,
  nativeRuntimeStatus,
  observeConfiguredNativeRuntimes,
  startNativeRuntime,
  stopNativeRuntime,
} from "./native-runtime-service.mjs";

/** WHAT: Routes native runtime lifecycle commands. WHY: Keeps endpoint truth and process ownership outside the main CLI router. */
export async function cmdRuntime({ flags, positional }, ctx) {
  const action = positional[0] || "status";
  const options = {
    port: flags.port || 8811,
    stateDir: flags["state-dir"],
    dataDir: flags["data-dir"],
    legacyDataDir: flags["no-legacy-migration"] ? null : undefined,
  };
  if (action === "status") {
    const scoped = flags.port !== undefined
      || flags["state-dir"] !== undefined
      || flags["data-dir"] !== undefined;
    if (!scoped) {
      const configured = await observeConfiguredNativeRuntimes({ agents: listAgents(ctx.configPath) });
      const managed = await discoverNativeRuntimes();
      console.log(formatNativeRuntimeStatuses(configured, { label: "configured" }));
      const configuredPorts = new Set(configured.map((status) => `${status.host}:${status.port}`));
      const additional = managed.filter((status) => !configuredPorts.has(`${status.host}:${status.port}`));
      if (additional.length) console.log(formatNativeRuntimeStatuses(additional, { label: "additional managed" }));
      if (configured.some((status) => !status.online)) process.exitCode = 1;
      if (!configured.length && !managed.length) {
        const fallback = await nativeRuntimeStatus(options);
        console.log(`No managed runtime discovered. Default :${fallback.port} is ${fallback.online ? "online but unmanaged" : "offline"}.`);
        if (!fallback.online) process.exitCode = 1;
      }
      return;
    }
    const status = await nativeRuntimeStatus(options);
    console.log(formatNativeRuntimeStatuses(status.managed ? [status] : []));
    if (!status.managed) console.log(`❌ :${status.port} · ${status.online ? "online but unmanaged" : "offline"} · data ${status.paths.dataDir}`);
    console.log(`Log: ${status.paths.logPath}`);
    if (!status.online) process.exitCode = 1;
    return;
  }
  if (action === "check") return console.log(await checkNativeRuntimeHealth(options));
  if (action === "start") {
    const result = await startNativeRuntime({
      ...options,
      serverPath: resolve(ctx.bridgeDir, "spikes/web-ui/server.mjs"),
    });
    console.log(`Native runtime ${result.alreadyRunning ? "already" : "now"} online at ${result.url} (pid ${result.pid || "external"}).`);
    return;
  }
  if (action === "stop") {
    const result = await stopNativeRuntime({ ...options, force: Boolean(flags.force) });
    console.log(result.alreadyStopped ? "Native runtime already stopped." : "Native runtime stopped; sessions remain persisted.");
    return;
  }
  if (action === "restart") {
    await stopNativeRuntime({ ...options, force: Boolean(flags.force) });
    const result = await startNativeRuntime({
      ...options,
      serverPath: resolve(ctx.bridgeDir, "spikes/web-ui/server.mjs"),
    });
    console.log(`Native runtime restarted at ${result.url} (pid ${result.pid}).`);
    return;
  }
  throw new Error(`unknown runtime action '${action}' (use status|check|start|stop|restart)`);
}
