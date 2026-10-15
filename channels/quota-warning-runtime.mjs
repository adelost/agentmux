// Bridge wiring for the weekly Claude quota warning.

import { fileURLToPath } from "node:url";
import { listAgents } from "../cli/config.mjs";
import { notifyUser } from "../cli/send-notify.mjs";
import { createState } from "../core/state.mjs";
import { readClaudeProfileIdentity } from "../core/claude-account-quota.mjs";
import { readClaudeQuotaBudgeted, readClaudeQuotaHistory } from "../core/claude-quota-budget.mjs";
import { quotaAccountCatalog } from "../core/quota-profiles.mjs";
import { accountEngineForCommand, runtimeProfileCatalog, selectedRuntimeProfile } from "../core/runtime-account-profiles.mjs";
import { runtimeAgentsPath } from "../core/runtime-defaults.mjs";
import { createAmuxCommentDeliverer } from "../core/suggestions-comment-bridge.mjs";
import {
  claudeAccountsOf, createQuotaWarningLoop, createSentNoticeStore, parseQuotaWarningConfig, runQuotaWarningTick,
} from "./quota-warning.mjs";

const LOOP_KEY = Symbol.for("agentmux.quotaWarningLoop");

/** WHAT: Builds a provenance-bearing durable panel delivery. WHY: Keeps reserve alarms on the same CLI queue as stall-watch. */
export function createQuotaWarningActorDeliverer({ deliver = createAmuxCommentDeliverer({
  amuxBin: fileURLToPath(new URL("../bin/agent-cli.mjs", import.meta.url)),
}) } = {}) {
  return (actor, text, { idempotencyKey }) => {
    const match = /^([a-zA-Z0-9_-]+):(\d+)$/u.exec(actor);
    if (!match) throw new Error("AMUX_QUOTA_WARN_ACTOR must be project:pane");
    return deliver({ agent: match[1], pane: Number(match[2]),
      prompt: `[quota-warning reserve]\n${text}`, idempotencyKey });
  };
}

/** WHAT: Builds the bridge quota tick with replaceable delivery boundaries. WHY: Allows real-quota previews without sending or recording notices. */
export function createQuotaWarningRuntimeTick({ env = process.env, notify = notifyUser,
  deliverActor = createQuotaWarningActorDeliverer(), sent = createSentNoticeStore() } = {}) {
  const config = parseQuotaWarningConfig(env);
  const configPath = runtimeAgentsPath();
  const state = createState(env.STATE_FILE || "/tmp/agentmux-state.json");
  const claudePanes = () => listAgents(configPath).flatMap((agent) => (agent.panes || []).flatMap((definition, pane) =>
    accountEngineForCommand(definition?.cmd) === "claude" ? [{ agentName: agent.name, pane, definition }] : []));
  const paneProfile = (catalog) => ({ agentName, pane, definition }) => selectedRuntimeProfile({
    state, agentName, pane, paneConfig: definition, provider: "claude", catalog });
  return () => runQuotaWarningTick({
    accountsInUse: () => claudeAccountsOf(claudePanes().map(paneProfile(runtimeProfileCatalog("claude"))),
      readClaudeProfileIdentity),
    allAccounts: () => claudeAccountsOf(quotaAccountCatalog().filter((profile) => profile.provider === "claude"),
      readClaudeProfileIdentity),
    readQuota: (profile) => readClaudeQuotaBudgeted({ profile }),
    historyOf: (profile) => readClaudeQuotaHistory(profile),
    notify, deliverActor, sent,
    config,
    now: Date.now(),
  });
}

/** WHAT: Schedules one warning loop per bridge process. WHY: Keeps the preload from stacking loops on a re-import. */
export function startQuotaWarning(env = process.env) {
  const config = parseQuotaWarningConfig(env);
  if (!config.enabled || globalThis[LOOP_KEY]) return globalThis[LOOP_KEY] || null;
  const loop = createQuotaWarningLoop({ config, tick: createQuotaWarningRuntimeTick({ env }) });
  globalThis[LOOP_KEY] = loop;
  loop.start();
  return loop;
}
