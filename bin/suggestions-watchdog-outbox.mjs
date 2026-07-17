#!/usr/bin/env node

import { resolve } from "path";
import { homedir } from "os";
import { listAgents, validateAgentPane } from "../cli/config.mjs";
import { createTmuxContext, getPaneStatus } from "../cli/tmux.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import {
  formatWatchdogFallbackView,
  watchdogFallbackView,
} from "../core/suggestions-watchdog-fallback.mjs";
import {
  assignmentDeliveryEligibility,
  createAmuxOutboxDeliverer,
  loadPrivateCredential,
  loadWatchdogOutboxConfig,
  pollWatchdogOutboxes,
} from "../core/suggestions-watchdog-outbox.mjs";
import { writeGuardHeartbeat } from "../core/guard-heartbeat.mjs";
import { readAllTurnsAcrossPanes } from "../core/jsonl-reader.mjs";
import { groupByPane } from "../core/orchestrator-checkpoint.mjs";

const DEFAULT_CONFIG = "~/.config/agent/suggestions-watchdog-outbox.yaml";

/** WHAT: Escalates one broker-unavailable generation directly to the human. WHY: Keeps fallback independent from the unavailable delivery broker. */
async function escalateBrokerUnavailable({ message, idempotencyKey }) {
  const { notifyUser } = await import("../cli/send-notify.mjs");
  return notifyUser(message, {
    level: "error",
    title: "Watchdog broker unavailable",
    idempotencyKey,
  });
}

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
  const agentConfigPath = process.env.AGENT_CONFIG
    || resolve(homedir(), ".config/agent/agents.yaml");
  const allowTestOrigin = process.env.NODE_ENV === "test"
    && process.env.AMUX_WATCHDOG_OUTBOX_TEST_ORIGIN === "1";
  const config = loadWatchdogOutboxConfig(configPath, { allowTestOrigin });
  const readToken = loadPrivateCredential(config.readCredentialFile);
  const adminToken = loadPrivateCredential(config.adminCredentialFile);
  if (args.status) {
    const projects = config.projects === null
      ? `auto discovery=${config.discoveryProject}`
      : config.projects.join(",");
    const queue = createDeliveryQueue();
    const fallbacks = queue.allTargets().flatMap(({ agentName, pane }) =>
      queue.list(agentName, pane).map((job) => watchdogFallbackView(job)).filter(Boolean))
      .sort((left, right) => Number(left.deadlineAt || 0) - Number(right.deadlineAt || 0))
      .slice(-20);
    console.log(`READY projects=${projects} base=${config.baseUrl} fallbacks=${fallbacks.length}`);
    for (const fallback of fallbacks) console.log(formatWatchdogFallbackView(fallback));
    process.exit(0);
  }
  const agents = listAgents(agentConfigPath);
  const tmux = createTmuxContext(process.env.TMUX_SOCKET || "/tmp/openclaw-claude.sock",
    agentConfigPath);
  const availability = async ({ agent, pane, idleMs }) => {
    const paneStatus = await getPaneStatus(tmux, agent, pane);
    const rows = readAllTurnsAcrossPanes({
      agents, agent, pane, limit: 200, tailBytes: 1024 * 1024,
    });
    const bucket = groupByPane(rows).get(`${agent}:${pane}`) || {};
    return assignmentDeliveryEligibility({
      paneStatus,
      lastAssistantText: bucket.lastAssistantText,
      lastAssistantAt: bucket.lastAssistantTextTs,
      lastUserAt: bucket.lastUserTextTs,
      idleMs,
    });
  };
  const result = await pollWatchdogOutboxes({
    config,
    readToken,
    adminToken,
    availability,
    deliver: createAmuxOutboxDeliverer({
      queue: createDeliveryQueue({
        validateTarget: (agent, pane) => validateAgentPane(agentConfigPath, agent, pane),
      }),
      waitMs: config.deliveryWaitMs,
      escalate: escalateBrokerUnavailable,
    }),
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
