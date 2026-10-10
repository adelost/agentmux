// Bridge wiring for the weekly Claude quota warning.

import { listAgents } from "../cli/config.mjs";
import { notifyUser } from "../cli/send-notify.mjs";
import { createState } from "../core/state.mjs";
import { readClaudeProfileIdentity } from "../core/claude-account-quota.mjs";
import { readClaudeQuotaBudgeted, readClaudeQuotaHistory } from "../core/claude-quota-budget.mjs";
import { quotaAccountCatalog } from "../core/quota-profiles.mjs";
import { accountEngineForCommand, runtimeProfileCatalog, selectedRuntimeProfile } from "../core/runtime-account-profiles.mjs";
import { runtimeAgentsPath } from "../core/runtime-defaults.mjs";
import {
  claudeAccountsOf, createQuotaWarningLoop, createSentNoticeStore, parseQuotaWarningConfig, runQuotaWarningTick,
} from "./quota-warning.mjs";

const LOOP_KEY = Symbol.for("agentmux.quotaWarningLoop");

/** WHAT: Schedules one warning loop per bridge process. WHY: Keeps the preload from stacking loops on a re-import. */
export function startQuotaWarning(env = process.env) {
  const config = parseQuotaWarningConfig(env);
  if (!config.enabled || globalThis[LOOP_KEY]) return globalThis[LOOP_KEY] || null;
  const configPath = runtimeAgentsPath();
  const state = createState(env.STATE_FILE || "/tmp/agentmux-state.json");
  const claudePanes = () => listAgents(configPath).flatMap((agent) => (agent.panes || []).flatMap((definition, pane) =>
    accountEngineForCommand(definition?.cmd) === "claude" ? [{ agentName: agent.name, pane, definition }] : []));
  const paneProfile = (catalog) => ({ agentName, pane, definition }) => selectedRuntimeProfile({
    state, agentName, pane, paneConfig: definition, provider: "claude", catalog });
  const loop = createQuotaWarningLoop({
    config,
    tick: () => runQuotaWarningTick({
      accountsInUse: () => claudeAccountsOf(claudePanes().map(paneProfile(runtimeProfileCatalog("claude"))),
        readClaudeProfileIdentity),
      allAccounts: () => claudeAccountsOf(quotaAccountCatalog().filter((profile) => profile.provider === "claude"),
        readClaudeProfileIdentity),
      readQuota: (profile) => readClaudeQuotaBudgeted({ profile }),
      historyOf: (profile) => readClaudeQuotaHistory(profile),
      notify: (text, options) => notifyUser(text, options),
      sent: createSentNoticeStore(),
      config,
      now: Date.now(),
    }),
  });
  globalThis[LOOP_KEY] = loop;
  loop.start();
  return loop;
}
