// WHAT: Prints what the bridge's Pulse transport counted: tmux questions, process starts and shadow differences.
// WHY: Keeps the bridge's watching cost readable without a CPU profile (docs/DESIGN-pulse.md, pulse-5).

import { formatIoSnapshot, readIoSnapshot } from "../core/pulse/io-counters.mjs";
import { PULSE_IO_PATH } from "../core/pulse/start-pulse.mjs";

const USAGE = `Usage: amux pulse io [--json]

Shows how the bridge reached tmux since it started: questions answered over its one
control-mode client, process starts, shadow checks and differences. The bridge
rewrites ~/.agentmux/pulse-io.json every 15 s when a count changed.
AMUX_PULSE_TRANSPORT=exec|shadow|control chooses the path (default control).`;

/** WHAT: Reports the bridge's Pulse counts for `amux pulse io`. WHY: Separates reading the counter file from the bridge that writes it. */
export function cmdPulse(args = [], { path = PULSE_IO_PATH, out = console.log } = {}) {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") return out(USAGE);
  if (sub !== "io") throw new Error(`Unknown pulse command '${sub}'.\n\n${USAGE}`);
  const snapshot = readIoSnapshot(path);
  if (rest.includes("--json")) return out(JSON.stringify(snapshot, null, 2));
  return out(formatIoSnapshot(snapshot));
}
