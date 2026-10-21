import { configuredClaudeTarget } from "./claude-quota-target.mjs";
import { contextMaintenanceAttempt } from "./context-maintenance.mjs";
import { classifyClaudeRotationPane } from "./account-rotation.mjs";
import { isDeliveryInFlight, PAUSED_UNTIL_RECOVERY, TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { moveTarget, quotaObservedAt, windDownContinuation, windDownMovesEnabled } from "./quota-wind-down.mjs";
import { cancelWindDownContinuation, releaseWindDownContinuation } from "./quota-wind-down-recovery.mjs";

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
    if (!windDown || !windDownMovesEnabled()) return refuse("wind-down-not-configured");
    const configured = configuredClaudeTarget(agentName, pane, { configPath });
    if (!configured || !episode?.startsWith(`${agentName}:${pane}|`)) return refuse("wind-down-episode-invalid");
    const resetAt = Number(episode.split("|").at(-1));
    const idempotencyKey = `quota-wind-down:moved:${agentName}:${pane}:${episode}`;
    const lease = queue.acquireSessionLease(agentName, pane);
    if (!lease) return refuse("delivery-session-busy");
    try {
      let continuation = queue.list(agentName, pane).find(job => job.idempotencyKey === idempotencyKey);
      if (continuation?.metadata?.windDownRestartedAt || (continuation && TERMINAL_DELIVERY_STATES.has(continuation.status))) {
        return { moved: true, replayed: true };
      }
      if (continuation?.cancelRequestStatus) return refuse("wind-down-continuation-cancelled");
      if (continuation && (await lifecycle.recoveredSession(agentName, pane,
        continuation.metadata.windDownSessionId, continuation.metadata.windDownTargetProfileKey))?.ok) {
        releaseWindDownContinuation(queue, continuation, now());
        return { moved: true, replayed: true };
      }
      if (!(resetAt > now())) return refuse("wind-down-episode-ended");
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
      if (continuation && (continuation.metadata.windDownTargetProfileKey !== profile.key
          || continuation.metadata.windDownSessionId !== identity.sessionId
          || continuation.metadata.windDownSourceProfileKey !== from.key)) return refuse("wind-down-intent-changed");
      const current = lifecycle.profileFor(agentName, pane);
      if (current?.key !== from.key && current?.key !== profile.key) return refuse("wind-down-source-changed");
      const verifiedAt = receipt.finishedAt ?? receipt.at;
      const quota = await windDown.readTargetQuota(profile, { notBefore: verifiedAt });
      if (quotaObservedAt(quota) > now() || !moveTarget({ engine: "claude", accounts: [quota], from,
        readAfter: Math.max(verifiedAt, now() - 10 * 60_000) })) return refuse("wind-down-target-no-fresh-room");
      if (!await admission()) return refuse("wind-down-evidence-changed");
      continuation ||= queue.enqueue({ agentName, pane, source: "quota-wind-down",
        text: windDownContinuation({ from: from.name, to: target.name }), idempotencyKey,
        orderKey: `0000000000000000:${idempotencyKey}`, nextAttemptAt: PAUSED_UNTIL_RECOVERY,
        metadata: { windDownSessionId: identity.sessionId, windDownTargetProfileKey: profile.key,
          windDownSourceProfileKey: from.key, windDownResetAt: resetAt } });
      try { lifecycle.selectProfile(agentName, pane, profile); }
      catch (error) {
        cancelWindDownContinuation(queue, continuation, `wind-down selection failed: ${error.message}`);
        return refuse(`wind-down-select-failed:${error.message}`);
      }
      const result = await lifecycle.restartAfterWindDown(agentName, pane,
        { sessionId: identity.sessionId, guard: admission }, profile.key);
      if (!result.ok) {
        cancelWindDownContinuation(queue, continuation, `wind-down restart failed: ${result.reason}`);
        return refuse(result.reason);
      }
      releaseWindDownContinuation(queue, continuation, now());
      return { moved: true, sessionId: identity.sessionId };
    } catch (error) {
      return refuse(`wind-down-move-failed:${error.message}`);
    } finally { lease.release(); }
  };
}
