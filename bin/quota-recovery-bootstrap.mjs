// Node preload that attaches quota recovery without growing the bridge entrypoint.

import { exec as execCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { readClaudeQuota } from "../core/quota-usage.mjs";
import { createClaudeQuotaLifecycle } from "../core/claude-quota-lifecycle.mjs";
import { createClaudeQuotaCoordinator } from "../core/claude-quota-coordinator.mjs";
import { createQuotaRecoveryLoop, parseQuotaRecoveryConfig } from "../channels/quota-recovery.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
try {
  const vars = parseEnv(readFileSync(`${ROOT}/.env`, "utf-8"));
  for (const [key, value] of Object.entries(vars)) {
    if (!process.env[key]) process.env[key] = value;
  }
} catch { /* The bridge entrypoint owns the required-env error message. */ }
const config = parseQuotaRecoveryConfig();

if (config.enabled) {
  const configPath = process.env.AGENTS_YAML || `${ROOT}/agents.yaml`;
  const tmuxSocket = process.env.TMUX_SOCKET || "/tmp/openclaw-claude.sock";
  const shellPath = process.env.SHELL_PATH || `${process.env.HOME}/bin:${process.env.PATH}`;
  const exec = promisify(execCallback);
  const tmuxExec = (command) => exec(command, {
    timeout: 3_000,
    env: { ...process.env, PATH: shellPath },
  });
  const queue = createDeliveryQueue();
  const lifecycle = createClaudeQuotaLifecycle({ configPath, tmuxSocket, tmuxExec });
  const coordinator = createClaudeQuotaCoordinator({
    queue,
    lifecycle,
    configPath,
    readQuota: () => readClaudeQuota(),
    resetGraceMs: config.resetGraceMs,
  });
  createQuotaRecoveryLoop({ coordinator, config }).start();
}
