#!/usr/bin/env node

import { resolve } from "path";
import {
  createAmuxOutboxDeliverer,
  loadPrivateCredential,
  loadWatchdogOutboxConfig,
  pollWatchdogOutboxes,
} from "../core/suggestions-watchdog-outbox.mjs";
import { writeGuardHeartbeat } from "../core/guard-heartbeat.mjs";

const DEFAULT_CONFIG = "~/.config/agent/suggestions-watchdog-outbox.yaml";

function expandHome(path) {
  if (path === "~") return process.env.HOME;
  if (String(path).startsWith("~/")) return resolve(process.env.HOME, String(path).slice(2));
  return resolve(String(path));
}

function parseArgs(argv) {
  const result = { config: null, status: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--status") result.status = true;
    else if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--config") {
      result.config = argv[++index];
      if (!result.config) throw new Error("--config requires a path");
    } else throw new Error(`unknown argument '${arg}'`);
  }
  return result;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: suggestions-watchdog-outbox.mjs [--config PATH] [--status]");
    process.exit(0);
  }
  const configPath = expandHome(args.config || process.env.AMUX_WATCHDOG_OUTBOX_CONFIG || DEFAULT_CONFIG);
  const allowTestOrigin = process.env.NODE_ENV === "test"
    && process.env.AMUX_WATCHDOG_OUTBOX_TEST_ORIGIN === "1";
  const config = loadWatchdogOutboxConfig(configPath, { allowTestOrigin });
  const readToken = loadPrivateCredential(config.readCredentialFile);
  const adminToken = loadPrivateCredential(config.adminCredentialFile);
  if (args.status) {
    console.log(`READY projects=${config.projects.join(",")} base=${config.baseUrl}`);
    process.exit(0);
  }
  const result = await pollWatchdogOutboxes({
    config,
    readToken,
    adminToken,
    deliver: createAmuxOutboxDeliverer({ waitMs: config.deliveryWaitMs }),
  });
  writeGuardHeartbeat({
    key: "watchdog-outbox",
    intervalSec: 60,
    metrics: {
      projects: result.projects,
      pending: result.pending,
      delivered: result.delivered,
    },
  });
  if (result.delivered > 0) console.log(`OK delivered=${result.delivered}`);
} catch (error) {
  console.error(`ERROR suggestions-watchdog-outbox: ${error.message}`);
  process.exit(1);
}
