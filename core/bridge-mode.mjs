// Bridge ownership policy shared by the CLI, doctor, and watchdog.

import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";

/** DTO: Foreground bridge ownership marker. */
export const BRIDGE_MODE_MANUAL = "manual";
/** DTO: Detached bridge ownership marker. */
export const BRIDGE_MODE_MANAGED = "managed";
/** DTO: Intentional bridge shutdown marker. */
export const BRIDGE_MODE_STOPPED = "stopped";
const VALID_MODES = new Set([BRIDGE_MODE_MANUAL, BRIDGE_MODE_MANAGED, BRIDGE_MODE_STOPPED]);

/** WHAT: Resolves the persisted bridge-mode file. WHY: Keeps CLI and watchdog ownership decisions on one path. */
export function bridgeModePath(env = process.env) {
  return env.AMUX_BRIDGE_MODE_FILE || join(env.HOME, ".agentmux", "bridge-mode");
}

/** WHAT: Loads the requested bridge ownership mode. WHY: Keeps absent state on the safe manual default. */
export function readBridgeMode({ path = bridgeModePath(), read = readFileSync } = {}) {
  try {
    const mode = read(path, "utf-8").trim();
    return VALID_MODES.has(mode) ? mode : BRIDGE_MODE_MANUAL;
  } catch {
    return BRIDGE_MODE_MANUAL;
  }
}

/** WHAT: Stores the requested bridge ownership mode. WHY: Lets intentional stops survive watchdog and WSL restarts. */
export function writeBridgeMode(mode, { path = bridgeModePath(), write = writeFileSync } = {}) {
  if (!VALID_MODES.has(mode)) throw new Error(`invalid bridge mode: ${mode}`);
  mkdirSync(dirname(path), { recursive: true });
  write(path, `${mode}\n`);
  return mode;
}

/** WHAT: Maps serve flags to one ownership mode. WHY: Keeps foreground as the unambiguous default across CLI paths. */
export function resolveServeMode(flags = {}) {
  const foreground = Boolean(flags.f || flags.fg || flags.foreground);
  const detached = Boolean(flags.d || flags.detach);
  if (foreground && detached) throw new Error("choose either foreground or --detach, not both");
  return detached ? BRIDGE_MODE_MANAGED : BRIDGE_MODE_MANUAL;
}
