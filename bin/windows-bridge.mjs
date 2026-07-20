#!/usr/bin/env node
// Thin CLI over core/windows-bridge.mjs for the Windows restarter poller.
// All decisions live in the core module; this file only parses argv and I/O.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyWindowsObservation,
  destructiveVerdict,
  formatWindowsStatus,
  planDiscordMessage,
  reconcileInterruptedState,
  WINDOWS_BRIDGE_CONTRACT_VERSION,
} from "../core/windows-bridge.mjs";

const [command, ...rest] = process.argv.slice(2);

function argValue(name) {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : null;
}

function decodeInput() {
  const encoded = argValue("--input-base64");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("input-base64-missing-or-invalid");
  }
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
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
  if (manifest?.schemaVersion !== 1
    || manifest.contractVersion !== WINDOWS_BRIDGE_CONTRACT_VERSION
    || !/^[0-9a-f]{40}$/u.test(manifest.sourceSha || "")
    || !manifest.files
    || typeof manifest.files !== "object") {
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

function planMessage() {
  console.log(JSON.stringify(planDiscordMessage(decodeInput())));
}

function reconcileState() {
  console.log(JSON.stringify(reconcileInterruptedState(decodeInput())));
}

function classifyStatus() {
  console.log(JSON.stringify(classifyWindowsObservation(decodeInput())));
}

function formatStatus() {
  console.log(formatWindowsStatus(decodeInput()));
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
  const verdict = destructiveVerdict({
    command: cmd,
    restartReadyReceipt: receipt,
    receiptId: argValue("--receipt-id"),
    bootId: argValue("--boot-id"),
    fleetGeneration: argValue("--fleet-generation"),
    sourceSha: argValue("--source-sha"),
  });
  console.log(JSON.stringify(verdict));
}

if (command === "contract-version") {
  console.log(`windows-bridge-contract ${WINDOWS_BRIDGE_CONTRACT_VERSION}`);
} else if (command === "self-check") {
  selfCheck();
} else if (command === "plan-message") {
  planMessage();
} else if (command === "reconcile-state") {
  reconcileState();
} else if (command === "classify-status") {
  classifyStatus();
} else if (command === "format-status") {
  formatStatus();
} else if (command === "destructive-check") {
  destructiveCheck();
} else {
  console.error("Usage: windows-bridge.mjs contract-version | self-check --manifest P --files-root D | plan-message --input-base64 B | reconcile-state --input-base64 B | classify-status --input-base64 B | format-status --input-base64 B | destructive-check --command C --receipt P --receipt-id ID --boot-id B --fleet-generation G --source-sha S");
  process.exit(2);
}
