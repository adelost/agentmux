#!/usr/bin/env node
// Read-only WSL side of the native Windows rescue bridge.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readHeartbeat } from "../core/heartbeat.mjs";
import { isGuardStateStale, readGuardState } from "../core/memory-guard.mjs";
import { observeReleaseIdentity } from "../core/release-identity.mjs";
import { buildWslObservation } from "../core/windows-wsl-probe.mjs";

function readBootId() {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
  catch { return null; }
}

function processAlive(pid) {
  if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const heartbeat = readHeartbeat();
const memoryState = readGuardState();
const identity = observeReleaseIdentity({
  runtimeRoot,
  entryPath: join(runtimeRoot, "bin", "agent-cli.mjs"),
  home: homedir(),
  // Windows status is local runtime truth. Remote drift is checked by doctor,
  // but a network dependency must never make the rescue channel hang.
  readRemoteMaster: () => {
    const manifest = JSON.parse(readFileSync(join(runtimeRoot, ".agentmux-release.json"), "utf8"));
    return manifest.sourceSha;
  },
});

console.log(JSON.stringify(buildWslObservation({
  bootId: readBootId(),
  heartbeat,
  pidAlive: processAlive(heartbeat?.pid),
  identity,
  memoryState,
  memoryStale: isGuardStateStale(memoryState),
}), null, 2));
