// Safe fleet-wide coding-account rotation.

import { join } from "node:path";
import { listAgents } from "./config.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue.mjs";
import {
  accountRotationOutcome,
  classifyClaudeRotationPane,
} from "../core/account-rotation.mjs";
import { latestClaudeSessionIdentity } from "../core/native-session-identity.mjs";
import {
  accountEngineForCommand,
  beginRuntimeProfileTransition,
  completeRuntimeProfileTransition,
  pendingRuntimeProfile,
  prepareRuntimeProfile,
  resolveRuntimeProfile,
  runtimeProfileAuthenticated,
  runtimeProfileCatalog,
  selectedRuntimeProfile,
  setRuntimeProfile,
} from "../core/runtime-account-profiles.mjs";
import { readClaudeQuota } from "../core/claude-account-quota.mjs";
import { assertRotationContinuity, readRotationContinuity } from "../core/rotation-continuity.mjs";

const paneKey = (agentName, pane) => `${agentName}:${pane}`;

function configuredClaudePanes(agents) {
  return agents.flatMap((agent) => (agent.panes || []).flatMap((definition, pane) =>
    accountEngineForCommand(definition?.cmd) === "claude"
      ? [{ agentName: agent.name, agent, pane, definition }]
      : []));
}

function liveDeliveryCount(queue, agentName, pane) {
  try {
    return queue.list(agentName, pane)
      .filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status)).length;
  } catch {
    return NaN;
  }
}

async function observePane(ctx, entry, catalog, target, deps) {
  const { agentName, agent, pane, definition } = entry;
  const processState = await ctx.agent.paneProcessState(agentName, pane).catch(() => null);
  const running = processState?.running === true;
  const [busy, transport] = running
    ? await Promise.all([
      ctx.agent.isBusy(agentName, pane).catch(() => null),
      ctx.agent.promptTransportState(agentName, pane, "").catch(() => null),
    ])
    : [null, null];
  const paneDir = join(agent.dir, ".agents", String(pane));
  const pending = pendingRuntimeProfile(ctx.state, agentName, pane);
  const identity = running || pending ? deps.latestIdentity(paneDir) : null;
  const liveDeliveryJobs = liveDeliveryCount(ctx.deliveryQueue, agentName, pane);
  let continuity = null, continuityError = null;
  if (identity) {
    try { continuity = deps.readContinuity(identity); }
    catch (error) { continuityError = error.message; }
  }
  let verdict = classifyClaudeRotationPane({
    processState,
    busy,
    transportState: transport?.state || null,
    liveDeliveryJobs,
    sessionId: identity?.sessionId || null,
  });
  if (pending) {
    if (pending.provider !== "claude" || pending.targetProfileId !== target.id) {
      verdict = { allow: false, mode: "blocked", reason: "different-transition-pending" };
    } else if (identity?.sessionId !== pending.sessionId) {
      verdict = { allow: false, mode: "blocked", reason: "pending-session-mismatch" };
    } else if (running) {
      verdict = verdict.allow
        ? { allow: true, mode: "recovering", reason: "restart-intent-recovered" }
        : verdict;
    } else if ((processState?.shell || processState?.dead || !processState?.command)
        && Number(liveDeliveryJobs) === 0) {
      verdict = { allow: true, mode: "recovering", reason: "restart-intent-recovered" };
    } else {
      verdict = { allow: false, mode: "blocked", reason: "pending-process-ambiguous" };
    }
  }
  if (verdict.allow && verdict.mode !== "dormant" && !continuity) {
    verdict = { allow: false, mode: "blocked", reason: continuityError || "rotation-session-unproven" };
  }
  return {
    ...entry,
    key: paneKey(agentName, pane),
    paneDir,
    processState,
    identity,
    continuity,
    pending,
    currentProfile: selectedRuntimeProfile({
      state: ctx.state,
      agentName,
      pane,
      paneConfig: definition,
      provider: "claude",
      catalog,
    }),
    ...verdict,
  };
}

function acquireFleetLeases(queue, panes) {
  const leases = [];
  for (const agentName of [...new Set(panes.map((pane) => pane.agentName))].sort()) {
    const lease = queue.acquireSessionLease?.(agentName);
    if (!lease) {
      for (const held of leases.reverse()) held.release();
      return { ok: false, reason: `delivery-lease-busy:${agentName}`, leases: [] };
    }
    leases.push(lease);
  }
  return { ok: true, leases };
}

function report(output, status, target, rows, reason = null) {
  output(`${status} claude:${target.id}${reason ? ` reason=${reason}` : ""}`);
  for (const row of rows) {
    output(`  ${row.key} ${row.status || row.mode}${row.reason ? ` (${row.reason})` : ""}`);
  }
}

/** WHAT: Routes Claude account changes through exact persisted sessions. WHY: Prevents exhausted source quota from blocking rotation while preserving drafts, queues and continuity. */
export async function rotateClaudeFleet(ctx, requested, {
  dry = false,
} = {}, dependencies = {}) {
  const deps = {
    agents: dependencies.agents || listAgents(ctx.configPath),
    catalog: dependencies.catalog || runtimeProfileCatalog("claude"),
    latestIdentity: dependencies.latestIdentity || latestClaudeSessionIdentity,
    authenticated: dependencies.authenticated || runtimeProfileAuthenticated,
    prepare: dependencies.prepare || prepareRuntimeProfile,
    access: dependencies.access || ((profile) => readClaudeQuota({ profile, refresh: !dry })),
    readContinuity: dependencies.readContinuity || readRotationContinuity,
    assertContinuity: dependencies.assertContinuity || assertRotationContinuity,
    output: dependencies.output || console.log,
    setExitCode: dependencies.setExitCode || ((code) => { process.exitCode = code; }),
  };
  const target = resolveRuntimeProfile("claude", requested, deps.catalog);
  if (!target) throw new Error(`unknown Claude account profile: ${requested}`);
  if (!deps.authenticated(target)) {
    const reason = "target-login-required";
    report(deps.output, "BLOCKED", target, [], reason);
    deps.setExitCode(1);
    return { status: "BLOCKED", reason, rows: [] };
  }
  const access = await deps.access(target);
  if (!access?.ok) {
    const reason = `target-access-unverified:${access?.error || "unknown"}`;
    report(deps.output, "BLOCKED", target, [], reason);
    deps.setExitCode(1);
    return { status: "BLOCKED", reason, rows: [] };
  }

  const panes = configuredClaudePanes(deps.agents);
  const leaseSet = acquireFleetLeases(ctx.deliveryQueue, panes);
  if (!leaseSet.ok) {
    report(deps.output, "BLOCKED", target, [], leaseSet.reason);
    deps.setExitCode(1);
    return { status: "BLOCKED", reason: leaseSet.reason, rows: [] };
  }

  try {
    const observed = [];
    for (const pane of panes) {
      observed.push(await observePane(ctx, pane, deps.catalog, target, deps));
    }
    const blocked = observed.filter((pane) => !pane.allow);
    if (blocked.length) {
      const rows = blocked.map((pane) => ({ ...pane, status: "blocked" }));
      report(deps.output, "BLOCKED", target, rows, "preflight-failed");
      deps.setExitCode(1);
      return { status: "BLOCKED", reason: "preflight-failed", rows };
    }
    if (dry) {
      const rows = observed.map((pane) => ({ ...pane, status: `would-${pane.mode}` }));
      report(deps.output, "DRY-RUN", target, rows);
      return { status: "DRY-RUN", rows };
    }

    deps.prepare(target, deps.catalog);
    const rows = [];
    for (const pane of observed) {
      // The fleet may take time to restart. Check EACH pane again immediately
      // before selecting or stopping it, under the same delivery lease.
      const rechecked = await observePane(ctx, pane, deps.catalog, target, deps);
      let reason = !rechecked.allow ? rechecked.reason : rechecked.mode !== pane.mode ? "rotation-pane-changed" : null;
      if (!reason && pane.mode !== "dormant") {
        try { deps.assertContinuity(pane.continuity, rechecked.identity); }
        catch (error) { reason = error.message; }
      }
      if (reason) {
        rows.push({ ...pane, status: "failed", reason });
        continue;
      }
      if (pane.mode === "dormant") {
        setRuntimeProfile(ctx.state, pane.agentName, pane.pane, "claude", target.id);
        rows.push({ ...pane, status: "selected-for-next-wake", reason: null });
        continue;
      }
      const sessionId = pane.pending?.sessionId || pane.identity.sessionId;
      const transition = pane.pending || beginRuntimeProfileTransition(ctx.state, {
        agentName: pane.agentName,
        pane: pane.pane,
        provider: "claude",
        previousProfileId: pane.currentProfile.id,
        targetProfileId: target.id,
        sessionId,
      });
      try {
        await ctx.agent.restartClaudeAccount(pane.agentName, pane.pane, {
          profile: target,
          resumeSessionId: sessionId,
          continuity: pane.continuity,
        });
        completeRuntimeProfileTransition(ctx.state, transition, target.id);
        rows.push({ ...pane, status: "switched", reason: null });
      } catch (error) {
        const previous = deps.catalog.find((profile) =>
          profile.id === transition.previousProfileId) || pane.currentProfile;
        if (!previous || previous.id === target.id) {
          rows.push({ ...pane, status: "failed", reason: error.message });
          continue;
        }
        setRuntimeProfile(ctx.state, pane.agentName, pane.pane, "claude", previous.id);
        try {
          deps.prepare(previous, deps.catalog);
          await ctx.agent.restartClaudeAccount(pane.agentName, pane.pane, {
            profile: previous,
            resumeSessionId: sessionId,
          });
          completeRuntimeProfileTransition(ctx.state, transition, previous.id);
          rows.push({ ...pane, status: "rolled-back", reason: error.message });
        } catch (rollbackError) {
          rows.push({
            ...pane,
            status: "failed",
            reason: `${error.message}; rollback-failed:${rollbackError.message}`,
          });
        }
      }
    }
    const outcome = accountRotationOutcome(rows);
    report(deps.output, outcome.status, target, rows);
    if (outcome.status !== "RECOVERED") deps.setExitCode(1);
    return { ...outcome, rows };
  } finally {
    for (const lease of leaseSet.leases.reverse()) lease.release();
  }
}
