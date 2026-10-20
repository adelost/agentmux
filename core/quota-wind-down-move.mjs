import { configuredClaudeTarget } from "./claude-quota-target.mjs";
import { contextMaintenanceAttempt } from "./context-maintenance.mjs";
import { classifyClaudeRotationPane } from "./account-rotation.mjs";
import { isDeliveryInFlight } from "./delivery-queue-policy.mjs";
import { moveTarget, quotaObservedAt, windDownContinuation } from "./quota-wind-down.mjs";

/** WHAT: Reads a verified compact within this episode and session. WHY: Prevents failed, old or superseded context from authorizing a move. */
export function windDownCompactReceipt({ state, agentName, pane, identity, beganAt, now = Date.now() }) {
  if (!identity?.sessionId || !Number.isFinite(beganAt) || beganAt > now) return null;
  const receipt = contextMaintenanceAttempt(state, agentName, pane, identity, now);
  const verifiedAt = receipt?.finishedAt ?? receipt?.at;
  return receipt?.status === "VERIFIED" && verifiedAt >= beganAt && verifiedAt <= now ? receipt : null;
}

/** WHAT: Builds the coordinator's wind-down move. WHY: Keeps account selection, exact restart and continuation under one session lease. */
export function createClaudeWindDownMove({ queue, lifecycle, configPath, now, windDown }) {
  return async function moveAfterWindDown(input) {
    const { agentName, pane, target, episode, beganAt, from } = input;
    const refuse = reason => ({ moved: false, reason });
    if (!windDown || process.env.AMUX_QUOTA_WIND_DOWN_MOVE === "false"
        || ["off", "dry"].includes(process.env.AMUX_QUOTA_WIND_DOWN)) return refuse("wind-down-not-configured");
    const configured = configuredClaudeTarget(agentName, pane, { configPath });
    if (!configured || !episode?.startsWith(`${agentName}:${pane}|`)
        || !(Number(episode.split("|").at(-1)) > now())) return refuse("wind-down-episode-ended");
    const idempotencyKey = `quota-wind-down:moved:${agentName}:${pane}:${episode}`;
    const existing = queue.list(agentName, pane).find(job => job.idempotencyKey === idempotencyKey);
    if (existing) return { moved: true, replayed: true };
    const lease = queue.acquireSessionLease(agentName, pane);
    if (!lease) return refuse("delivery-session-busy");
    try {
      const identity = windDown.identityFor("claude", configured.cwd);
      const receiptFor = () => windDownCompactReceipt({ ...input, state: windDown.state,
        identity: windDown.identityFor("claude", configured.cwd), now: now() });
      const receipt = receiptFor();
      if (!receipt) return refuse("wind-down-compact-unverified");
      const admission = async () => {
        const current = windDown.identityFor("claude", configured.cwd);
        if (current?.sessionId !== identity.sessionId || !receiptFor() || lifecycle.activeReceipt(agentName, pane)) return false;
        const transport = await windDown.agent.promptTransportState(agentName, pane, "");
        const gate = classifyClaudeRotationPane({ processState: await windDown.agent.paneProcessState(agentName, pane),
          busy: await windDown.agent.isBusy(agentName, pane) || Boolean(transport?.busy),
          transportState: transport?.state,
          liveDeliveryJobs: queue.list(agentName, pane).filter(isDeliveryInFlight).length, sessionId: identity.sessionId });
        return gate.allow && gate.mode === "running";
      };
      if (!await admission()) return refuse("wind-down-pane-not-idle");
      const profile = windDown.profiles().find(candidate => candidate.id === target.profileId);
      if (!profile || !target.profileKeys.includes(profile.key)) return refuse("wind-down-target-changed");
      const current = lifecycle.profileFor(agentName, pane);
      if (current?.key !== from.key && current?.key !== profile.key) return refuse("wind-down-source-changed");
      const verifiedAt = receipt.finishedAt ?? receipt.at;
      const quota = await windDown.readTargetQuota(profile, { notBefore: verifiedAt });
      if (quotaObservedAt(quota) > now() || !moveTarget({ engine: "claude", accounts: [quota], from,
        readAfter: Math.max(verifiedAt, now() - 10 * 60_000) })) return refuse("wind-down-target-no-fresh-room");
      if (!await admission()) return refuse("wind-down-evidence-changed");
      lifecycle.selectProfile(agentName, pane, profile);
      const result = await lifecycle.restartAfterWindDown(agentName, pane,
        { sessionId: identity.sessionId, guard: admission }, profile.key);
      if (!result.ok) return refuse(result.reason);
      queue.enqueue({ agentName, pane, source: "quota-wind-down",
        text: windDownContinuation({ from: from.name, to: target.name }), idempotencyKey,
        metadata: { windDownSessionId: identity.sessionId, windDownRestartedAt: now() } });
      return { moved: true, sessionId: identity.sessionId };
    } catch (error) {
      return refuse(`wind-down-move-failed:${error.message}`);
    } finally { lease.release(); }
  };
}
