#!/usr/bin/env node
// Thin CLI over core/memory-guard.mjs.
//
//   node bin/memory-guard.mjs poll
//     Sample once, advance the durable state, print it. (The bridge normally
//     polls in-process; this is the manual/debug path.)
//   node bin/memory-guard.mjs check --class pane-revive [--reserve-mib N]
//     Admission decision for an AUTOMATIC heavy start from a LIVE meminfo
//     sample — exit 0 allows, exit 1 refuses with a classified reason on
//     stderr. A live sample is its own freshness proof, so boot-time checks
//     never fail closed on a stale state file.

import { readFileSync } from "node:fs";
import {
  canStartHeavy, classifyMemory, parseMeminfo, pollMemoryGuardOnce,
} from "../core/memory-guard.mjs";

const [command, ...rest] = process.argv.slice(2);

function argValue(name, fallback = null) {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : fallback;
}

function bootId() {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
  catch { return null; }
}

if (command === "poll") {
  const { state, previousLevel, changed } = pollMemoryGuardOnce();
  console.log(JSON.stringify({ ...state, previousLevel, changed }, null, 2));
} else if (command === "check") {
  const heavyClass = argValue("--class");
  const reserveMiB = Number(argValue("--reserve-mib", "0")) || 0;
  const sample = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
  const liveState = {
    bootId: bootId(),
    observedAt: Date.now(),
    level: classifyMemory(sample),
    sample,
  };
  const verdict = canStartHeavy(liveState, {
    class: heavyClass,
    reserveMiB,
    automatic: true,
  });
  if (!verdict.ok) {
    console.error(`memory-guard REFUSED ${heavyClass}: ${verdict.reason}`);
    process.exit(1);
  }
  console.log(`memory-guard allowed ${heavyClass}: ${verdict.reason}`);
} else {
  console.error("Usage: node bin/memory-guard.mjs poll | check --class <class> [--reserve-mib N]");
  process.exit(2);
}
