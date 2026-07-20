#!/usr/bin/env node
// Thin CLI over core/windows-bridge.mjs for the Windows restarter poller.
// All decisions live in the core module; this file only parses argv and I/O.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  destructiveVerdict,
  WINDOWS_BRIDGE_CONTRACT_VERSION,
} from "../core/windows-bridge.mjs";

const [command, ...rest] = process.argv.slice(2);

function argValue(name) {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : null;
}

function selfCheck() {
  const manifestPath = argValue("--manifest");
  const filesRoot = argValue("--files-root");
  if (!manifestPath || !filesRoot) {
    console.error("SELF_CHECK_FAILED reason=usage:self-check-needs-manifest-and-files-root");
    process.exit(1);
  }
  if (Number(process.versions.node.split(".")[0]) < 20) {
    console.error(`SELF_CHECK_FAILED reason=node-version:${process.versions.node}`);
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    console.error("SELF_CHECK_FAILED reason=manifest-unreadable");
    process.exit(1);
  }
  if (manifest?.schemaVersion !== 1 || !manifest.files || typeof manifest.files !== "object") {
    console.error("SELF_CHECK_FAILED reason=manifest-shape");
    process.exit(1);
  }
  for (const [name, expected] of Object.entries(manifest.files)) {
    let bytes;
    try {
      bytes = readFileSync(join(filesRoot, name));
    } catch {
      console.error(`SELF_CHECK_FAILED reason=missing:${name}`);
      process.exit(1);
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
      console.error(`SELF_CHECK_FAILED reason=hash-mismatch:${name}`);
      process.exit(1);
    }
  }
  console.log("SELF_CHECK_OK");
}

function destructiveCheck() {
  const cmd = argValue("--command");
  const receiptPath = argValue("--receipt");
  let receipt = null;
  if (receiptPath) {
    try {
      receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
    } catch {
      receipt = null;
    }
  }
  const generation = argValue("--generation");
  const verdict = destructiveVerdict({ command: cmd, restartReadyReceipt: receipt, generation });
  console.log(JSON.stringify(verdict));
}

if (command === "contract-version") {
  console.log(`windows-bridge-contract ${WINDOWS_BRIDGE_CONTRACT_VERSION}`);
} else if (command === "self-check") {
  selfCheck();
} else if (command === "destructive-check") {
  destructiveCheck();
} else {
  console.error("Usage: windows-bridge.mjs contract-version | self-check --manifest P --files-root D | destructive-check --command C [--receipt P] [--generation G]");
  process.exit(2);
}
