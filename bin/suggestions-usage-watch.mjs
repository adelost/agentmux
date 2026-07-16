#!/usr/bin/env node

import { resolve } from "node:path";
import { validateAgentPane } from "../cli/config.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { writeGuardHeartbeat } from "../core/guard-heartbeat.mjs";
import {
  createRowsReadAlertDeliverer,
  loadCloudflareAnalyticsCredential,
  loadSuggestionsUsageConfig,
  observeDurableObjectsRowsRead,
} from "../core/suggestions-usage.mjs";

const configPath = resolve(process.argv[2]
  || process.env.AMUX_SUGGESTIONS_USAGE_CONFIG
  || `${process.env.HOME}/.config/agent/suggestions-usage-watch.yaml`);
const agentConfigPath = process.env.AGENT_CONFIG
  || `${process.env.HOME}/.config/agent/agents.yaml`;

try {
  const config = loadSuggestionsUsageConfig(configPath);
  const token = loadCloudflareAnalyticsCredential(config.credentialFile);
  const result = await observeDurableObjectsRowsRead({
    config,
    token,
    deliver: createRowsReadAlertDeliverer({
      queue: createDeliveryQueue({
        validateTarget: (agent, pane) => validateAgentPane(agentConfigPath, agent, pane),
      }),
      agent: config.agent,
      pane: config.pane,
      waitMs: config.deliveryWaitMs,
    }),
  });
  writeGuardHeartbeat({
    key: "suggestions-usage",
    intervalSec: 15 * 60,
    metrics: {
      status: result.snapshot.tier,
      period: config.period,
      periodKey: result.snapshot.periodKey,
      rowsRead: result.snapshot.rowsRead,
      budgetRows: result.snapshot.budgetRows,
      ratio: result.snapshot.ratio,
      remainingRows: result.snapshot.remainingRows,
      alertDelivered: result.delivery != null,
    },
  });
  if (result.snapshot.tier !== "ok") {
    console.log(`ALERT tier=${result.snapshot.tier} rowsRead=${result.snapshot.rowsRead} `
      + `budget=${result.snapshot.budgetRows} period=${result.snapshot.periodKey}`);
  }
} catch (error) {
  try {
    writeGuardHeartbeat({ key: "suggestions-usage", intervalSec: 15 * 60,
      metrics: { status: "failed", error: String(error.message).slice(0, 160) } });
  } catch {}
  console.error(`ERROR suggestions-usage-watch: ${error.message}`);
  process.exitCode = 1;
}
