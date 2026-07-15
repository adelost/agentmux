#!/usr/bin/env node

import { writeGuardHeartbeat } from "../core/guard-heartbeat.mjs";

const parseScalar = (value) => {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return value;
};

const args = process.argv.slice(2);
let key = null;
let intervalSec = null;
const metrics = {};
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--key") key = args[++index];
  else if (arg === "--interval-sec") intervalSec = Number(args[++index]);
  else if (arg === "--metric") {
    const pair = args[++index] ?? "";
    const separator = pair.indexOf("=");
    if (separator < 1) throw new Error("--metric requires name=value");
    metrics[pair.slice(0, separator)] = parseScalar(pair.slice(separator + 1));
  } else throw new Error(`unknown argument '${arg}'`);
}

writeGuardHeartbeat({ key, intervalSec, metrics });
