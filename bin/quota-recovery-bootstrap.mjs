// Node preload that attaches quota recovery without growing the bridge entrypoint.
// The quota warning is not here: it answers human messages (bot.mjs).

import { exec as execCallback } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { parseEnv } from "../lib.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createState } from "../core/state.mjs";
import { readClaudeQuotaBudgeted } from "../core/claude-quota-budget.mjs";
import { readClaudeProfileIdentity } from "../core/claude-account-quota.mjs";
import { spareClaudeAccount } from "../core/claude-quota-recovery.mjs";
import { runtimeProfileAuthenticated, runtimeProfileCatalog } from "../core/runtime-account-profiles.mjs";
import { parseQuotaWarningConfig } from "../channels/quota-warning.mjs";
import { createClaudeQuotaLifecycle } from "../core/claude-quota-lifecycle.mjs";
import { createClaudeQuotaCoordinator } from "../core/claude-quota-coordinator.mjs";
import { createSelfCompactStore } from "../core/self-compact.mjs";
import { parkHoldsMove } from "../core/quota-park.mjs";
import { createQuotaParkStore } from "../core/quota-park-store.mjs";
import { createQuotaRecoveryLoop, parseQuotaRecoveryConfig } from "../channels/quota-recovery.mjs";
import { startIdleCapacityAlarm } from "../channels/idle-capacity-runtime.mjs";
import { writeQuotaRecoveryHeartbeat } from "../core/quota-recovery-heartbeat.mjs";
import { DEFAULT_TMUX_SOCKET, runtimeAgentsPath } from "../core/runtime-defaults.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
try {
  const vars = parseEnv(readFileSync(`${ROOT}/.env`, "utf-8"));
  for (const [key, value] of Object.entries(vars)) {
    if (!process.env[key]) process.env[key] = value;
  }
} catch { /* The bridge entrypoint owns the required-env error message. */ }
const config = parseQuotaRecoveryConfig();
const LOOP_KEY = Symbol.for("agentmux.quotaRecoveryLoop");

if (!config.enabled) {
  try { writeQuotaRecoveryHeartbeat({ state: "disabled" }); } catch {}
} else if (!globalThis[LOOP_KEY]) {
  const configPath = runtimeAgentsPath();
  const tmuxSocket = process.env.TMUX_SOCKET || DEFAULT_TMUX_SOCKET;
  const shellPath = process.env.SHELL_PATH || `${process.env.HOME}/bin:${process.env.PATH}`;
  const exec = promisify(execCallback);
  const tmuxExec = (command) => exec(command, {
    timeout: 3_000,
    env: { ...process.env, PATH: shellPath },
  });
  const queue = createDeliveryQueue();
  const state = createState(process.env.STATE_FILE || "/tmp/agentmux-state.json");
  const lifecycle = createClaudeQuotaLifecycle({ configPath, tmuxSocket, tmuxExec, state });
  const selfRequests = createSelfCompactStore();
  const parkStore = createQuotaParkStore();
  const coordinator = createClaudeQuotaCoordinator({
    queue,
    lifecycle,
    configPath,
    // A parked pane polls every 30 s; the shared budget keeps that to one usage call per
    // account per five minutes, and never answers with a reading older than the limit.
    // A quota park asks for a reading taken after the park, a limit for one taken after the limit.
    readQuota: ({ agentName, pane, receipt, notBefore = 0 }) => readClaudeQuotaBudgeted({
      profile: lifecycle.profileFor(agentName, pane),
      notBefore: Number.isFinite(receipt?.observedAt) ? receipt.observedAt : notBefore,
    }),
    // The same shared budget reads the other logins, and only for a pane whose week is spent.
    findSpareAccount: ({ current, receipt }) => spareClaudeAccount({
      current,
      catalog: runtimeProfileCatalog("claude"),
      authenticated: runtimeProfileAuthenticated,
      emailOf: (profile) => readClaudeProfileIdentity(profile)?.email?.toLowerCase() || null,
      readQuota: (profile) => readClaudeQuotaBudgeted({
        profile,
        notBefore: Number.isFinite(receipt?.observedAt) ? receipt.observedAt : 0,
      }),
      reservePercent: parseQuotaWarningConfig().reservePercent,
    }),
    resetGraceMs: config.resetGraceMs,
    parkPending: (agentName, pane) => parkHoldsMove(selfRequests.read(agentName, pane), Date.now()),
    parkStore,
  });
  const loop = createQuotaRecoveryLoop({ coordinator, config });
  globalThis[LOOP_KEY] = loop;
  loop.start();
  // Off unless AMUX_IDLE_CAPACITY_TARGET names the pane that staffs the fleet.
  try {
    startIdleCapacityAlarm({ queue, state, configPath, tmuxSocket, tmuxExec, parkStore,
      activeReceipt: (agentName, pane) => lifecycle.activeReceipt(agentName, pane),
      profileFor: (agentName, pane) => lifecycle.profileFor(agentName, pane) });
  } catch (error) { console.log(`idle-capacity | start failed: ${error.message}`); }
}
