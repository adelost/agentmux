// WHAT: Prints what the bridge's Pulse transport counted: tmux questions, process starts and shadow differences.
// WHY: Keeps the bridge's watching cost readable without a CPU profile (docs/DESIGN-pulse.md, pulse-5).

import { formatIoSnapshot, readIoSnapshot } from "../core/pulse/io-counters.mjs";
import { PULSE_IO_PATH } from "../core/pulse/start-pulse.mjs";
import { readFileSync } from "fs";
import { READ_METER_FLAG, READ_METER_PATH } from "../core/pulse/read-meter.mjs";

const USAGE = `Usage: amux pulse io [--json]

Shows how the bridge reached tmux since it started: questions answered over its one
control-mode client, process starts, shadow checks and differences. The bridge
rewrites ~/.agentmux/pulse-io.json every 15 s when a count changed.
AMUX_PULSE_TRANSPORT=exec|shadow|control chooses the path (default control).

Usage: amux pulse reads [--json]

Shows the bytes the bridge read from files by reader and kind while ${READ_METER_FLAG}
exists (touch it to start counting from zero, remove it to stop); the bridge rewrites
${READ_METER_PATH} every 15 s.`;

/** WHAT: Reports the bridge's Pulse counts for `amux pulse io`. WHY: Separates reading the counter file from the bridge that writes it. */
export function cmdPulse(args = [], { path = PULSE_IO_PATH, out = console.log } = {}) {
  const [sub, ...rest] = args;
  if (!sub || sub === "--help" || sub === "-h" || sub === "help") return out(USAGE);
  if (sub === "reads") return out(formatReads(JSON.parse(readFileSync(READ_METER_PATH, "utf8")), rest.includes("--json")));
  if (sub !== "io") throw new Error(`Unknown pulse command '${sub}'.\n\n${USAGE}`);
  const snapshot = readIoSnapshot(path);
  if (rest.includes("--json")) return out(JSON.stringify(snapshot, null, 2));
  return out(formatIoSnapshot(snapshot));
}

/** WHAT: Lays out the read meter's counts, MB per 10 s with the biggest readers first. WHY: Keeps row 124's cost readable by reader and file kind. */
function formatReads(snapshot, json) {
  if (json) return JSON.stringify(snapshot, null, 2);
  const seconds = Math.max(1, (snapshot.at - snapshot.since) / 1000), rate = (bytes) => (bytes / 1e6 / seconds * 10).toFixed(1);
  const head = `reads ${snapshot.on ? "on" : "off"} · ${Math.round(seconds)} s · ${rate(snapshot.total)} MB per 10 s in ${snapshot.calls} reads`;
  const lines = [head, "", "by kind (MB per 10 s)"];
  for (const [kind, bytes] of Object.entries(snapshot.byKind).sort((a, b) => b[1] - a[1]).slice(0, 10)) lines.push(`${rate(bytes).padStart(8)}  ${kind}`);
  lines.push("", "by reader (MB per 10 s, reads)");
  for (const r of snapshot.readers.slice(0, 15)) lines.push(`${rate(r.bytes).padStart(8)} ${String(r.calls).padStart(7)}  ${r.who}`);
  return lines.join("\n");
}
