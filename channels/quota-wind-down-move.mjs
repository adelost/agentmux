import { createClaudeQuotaCoordinator } from "../core/claude-quota-coordinator.mjs";
import { createClaudeQuotaLifecycle } from "../core/claude-quota-lifecycle.mjs";
import { readClaudeQuotaBudgeted } from "../core/claude-quota-budget.mjs";
import { runtimeProfileCatalog } from "../core/runtime-account-profiles.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { runRequestedCodexSwitch } from "../cli/codex-account-switch.mjs";
import { windDownMovesEnabled } from "../core/quota-wind-down.mjs";

/** WHAT: Routes poll-admitted moves to each engine's existing lifecycle. WHY: Keeps wind-down on the exact-session switch paths without a second scheduler. */
export function createQuotaWindDownMover({ agent, state, queue, configPath, tmuxSocket, tmuxExec, accountFor,
  lifecycle = createClaudeQuotaLifecycle({ configPath, tmuxSocket, tmuxExec, state }),
  identityFor = latestPaneSessionIdentity, profiles = () => runtimeProfileCatalog("claude"),
  readTargetQuota = (profile, { notBefore }) => readClaudeQuotaBudgeted({ profile, notBefore }),
  codexOptions = {}, now = Date.now }) {
  const coordinator = createClaudeQuotaCoordinator({ queue, lifecycle, configPath,
    readQuota: ({ agentName, pane }) => readTargetQuota(lifecycle.profileFor(agentName, pane), { notBefore: 0 }),
    windDown: { state, agent, identityFor, profiles, readTargetQuota }, now });
  const ctx = { agent, state, deliveryQueue: queue, configPath };
  return async input => {
    if (!windDownMovesEnabled()) return { moved: false, reason: "wind-down-moves-disabled" };
    const fresh = await accountFor(`${input.agentName}:${input.pane}`, { fresh: true });
    if (fresh?.account?.key !== input.from.key) return { moved: false, reason: "wind-down-source-changed" };
    if (input.engine === "claude") return coordinator.moveAfterWindDown(input);
    if (input.engine === "codex") return runRequestedCodexSwitch(ctx, input.agentName, input.pane, {
      ...codexOptions, now, to: input.target, windDown: { episode: input.episode, beganAt: input.beganAt,
        sessionId: input.identity.sessionId, from: input.from } });
    return { moved: false, reason: "wind-down-engine-unsupported" };
  };
}
