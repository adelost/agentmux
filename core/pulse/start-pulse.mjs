// WHAT: Starts the bridge's Pulse transport and keeps its counter file current for `amux pulse io`.
// WHY: Keeps index.mjs to one wiring line and the mode, counters and file writer in one owner.

import { homedir } from "os";
import { join } from "path";
import { createControlTransport, TRANSPORT_MODES } from "./control-transport.mjs";
import { createIoCounters, saveIoSnapshot } from "./io-counters.mjs";
import { createPaneSnapshot } from "./pane-snapshot.mjs";

/** WHAT: Names the counter file `amux pulse io` reads. WHY: Keeps the bridge and the CLI on one path. */
export const PULSE_IO_PATH = join(homedir(), ".agentmux", "pulse-io.json");
const WRITE_EVERY_MS = 15_000;

/**
 * WHAT: Returns an exec with tmuxExec's shape, answered per AMUX_PULSE_TRANSPORT (exec, shadow or control).
 * WHY: Prevents a mistyped mode from silently changing the path: it is logged and the process path is used.
 */
export function startPulse({ socket, processExec, env = process.env, ioPath = PULSE_IO_PATH,
  log = (line) => console.log(`[pulse] ${line}`), spawnClient } = {}) {
  const counters = createIoCounters();
  let mode = env.AMUX_PULSE_TRANSPORT || "control";
  if (!TRANSPORT_MODES.has(mode)) {
    console.error(`[pulse] AMUX_PULSE_TRANSPORT=${JSON.stringify(mode)} is not exec, shadow or control; using exec`);
    mode = "exec";
  }
  const transport = createControlTransport({ socket, processExec, mode, counters, log, ...(spawnClient ? { spawnClient } : {}) });
  counters.setTransport(transport.state());
  let written = null;
  const writer = setInterval(() => {
    const snapshot = counters.snapshot();
    const key = JSON.stringify([snapshot.totals, snapshot.transport, snapshot.disagreementCount]);
    if (key === written) return;
    try { saveIoSnapshot(ioPath, snapshot); written = key; }
    catch (error) { log(`counter file not written: ${error.message}`); }
  }, WRITE_EVERY_MS);
  writer.unref?.();
  const fleet = createPaneSnapshot({ socket, exec: transport.exec });
  return { exec: transport.exec, fleet, transport, counters, stop: () => { clearInterval(writer); transport.stop(); } };
}
