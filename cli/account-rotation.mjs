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
  resolveClaudeAccountTarget,
  runtimeProfileAuthenticated,
  runtimeProfileCatalog,
  selectedRuntimeProfile,
  setRuntimeProfile,
} from "../core/runtime-account-profiles.mjs";
import { readClaudeQuotaBudgeted } from "../core/claude-quota-budget.mjs";
import { readClaudeProfileIdentity } from "../core/claude-account-quota.mjs";
import { assertRotationContinuity, readRotationContinuity } from "../core/rotation-continuity.mjs";
import { accountSwitchPlan } from "../policies/account-switch-cost.mjs";
import { readContextCostPolicy } from "../policies/context-cost.mjs";
import { compactBeforeSwitch, observeSwitchContext } from "./account-switch-compact.mjs";

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

function projectsFor(panes) {
  const projects = new Map();
  for (const pane of panes) {
    if (!projects.has(pane.agentName)) projects.set(pane.agentName, []);
    projects.get(pane.agentName).push(pane);
  }
  return [...projects].sort(([left], [right]) => left.localeCompare(right));
}

function blockedProjectRows(panes, reason, culprit = null) {
  return panes.map((pane) => ({
    ...pane,
    key: pane.key || paneKey(pane.agentName, pane.pane),
    status: "blocked",
    reason: culprit && pane.key !== culprit.key ? `project-preflight-failed:${culprit.key}` : reason,
  }));
}

function paneChangeReason(before, after, deps) {
  if (!after.allow) return after.reason;
  if (after.mode !== before.mode) return "rotation-pane-changed";
  if (after.currentProfile?.id !== before.currentProfile?.id) return "rotation-profile-changed";
  if (after.pending?.sessionId !== before.pending?.sessionId
      || after.pending?.targetProfileId !== before.pending?.targetProfileId) {
    return "rotation-transition-changed";
  }
  if (before.mode === "dormant") return null;
  try { deps.assertContinuity(before.continuity, after.identity); }
  catch (error) { return error.message; }
  return null;
}

function report(output, status, target, rows, reason = null) {
  output(`${status} claude:${target.id}${reason ? ` reason=${reason}` : ""}`);
  for (const row of rows) {
    output(`  ${row.key} ${row.status || row.mode}${row.reason ? ` (${row.reason})` : ""}`);
  }
}

const planReason = ({ reason, tokens, idleMs }) => [reason,
  [Number.isFinite(tokens) ? `${Math.round(tokens / 1000)}k` : null,
    Number.isFinite(idleMs) ? `idle ${Math.round(idleMs / 60_000)}m` : null].filter(Boolean).join(", ")]
  .filter(Boolean).join(" ");

// Dormant and already-selected rows keep the wording they always had.
const DRY_STATUS = { SELECT: (pane) => `would-${pane.mode}`,
  RESTART: (pane) => `would-${pane.mode}`, COMPACT_THEN_RESTART: () => "would-compact-then-restart" };

const keepReason = (pane, target) => pane.currentProfile?.id === target.id ? pane.reason : "same-account";

function dryRow(pane, target) {
  if (pane.plan.action === "HOLD") return { ...pane, status: "blocked", reason: planReason(pane.plan) };
  if (pane.plan.action === "KEEP") return { ...pane, status: "would-already-selected", reason: keepReason(pane, target) };
  const moving = pane.plan.action === "RESTART" || pane.plan.action === "COMPACT_THEN_RESTART";
  return { ...pane, status: DRY_STATUS[pane.plan.action](pane), reason: moving ? planReason(pane.plan) : pane.reason };
}

const emailOf = (profile, identityOf) => profile ? identityOf(profile)?.email?.toLowerCase() || null : null;

// Another dir of the same login changes Claude Code's system prompt (its config path), so moving is a cache miss for nothing.
const onTargetAccount = (pane, target, identityOf) => !pane.pending && (pane.currentProfile?.id === target.id
  || (emailOf(pane.currentProfile, identityOf) !== null
    && emailOf(pane.currentProfile, identityOf) === emailOf(target, identityOf)));

/** WHAT: Attaches each allowed pane's cost-aware switch action. WHY: Keeps a warm large context from moving without its compact. */
async function planPanes(ctx, observed, target, deps, compactedKeys = new Set()) {
  const planned = [];
  for (const pane of observed) {
    const alreadySelected = onTargetAccount(pane, target, deps.identityOf);
    const context = pane.mode === "running" && !alreadySelected ? await deps.observeContext(ctx, pane) : null;
    const plan = accountSwitchPlan({ mode: pane.mode, alreadySelected, facts: context?.facts,
      compactRefusal: context?.compactRefusal, compacted: context?.compacted || compactedKeys.has(pane.key) }, deps.policy);
    planned.push({ ...pane, plan, compactTarget: context?.target || null });
  }
  return planned;
}

/** WHAT: Compacts the warm large panes on their source outside the project lease. WHY: Keeps the compact on its own pane lease and an unverified receipt from moving the pane. */
async function compactMovers(ctx, movers, deps, rows) {
  const compacted = new Set();
  for (const pane of movers.filter((candidate) => candidate.plan.action === "COMPACT_THEN_RESTART")) {
    const result = await deps.compactPane(ctx, pane.compactTarget).catch((error) => ({ ok: false, reason: error.message }));
    if (result.ok) compacted.add(pane.key);
    else rows.push({ ...pane, status: "blocked", reason: result.reason });
  }
  return compacted;
}

/** WHAT: Prepares, rechecks and restarts or selects one project's movers under its lease. WHY: Keeps every existing continuity, rollback and partial-outcome guard on the moving panes. */
async function switchPanes(ctx, observed, target, deps, rows, prepareOnce) {
  prepareOnce();
  const recheckedProject = [];
  for (const pane of observed) recheckedProject.push(await observePane(ctx, pane, deps.catalog, target, deps));
  const changed = recheckedProject.map((pane, index) => ({
    pane,
    reason: paneChangeReason(observed[index], pane, deps),
  })).find((entry) => entry.reason);
  if (changed) {
    rows.push(...blockedProjectRows(observed, changed.reason, changed.pane));
    return;
  }
  for (const pane of observed) {
    // A later pane can change while earlier panes restart under this lease.
    const rechecked = await observePane(ctx, pane, deps.catalog, target, deps);
    const reason = paneChangeReason(pane, rechecked, deps);
    if (reason) {
      rows.push({ ...pane, status: "failed", reason });
      continue;
    }
    if (pane.plan.action === "KEEP") {
      rows.push({ ...pane, status: "already-selected", reason: pane.currentProfile?.id === target.id ? null : "same-account" });
      continue;
    }
    if (pane.mode === "dormant") {
      setRuntimeProfile(ctx.state, pane.agentName, pane.pane, "claude", target.id);
      rows.push({ ...pane, status: "selected-for-next-wake", reason: null });
      continue;
    }
    rows.push(await restartOnTarget(ctx, pane, target, deps));
  }
}

async function restartOnTarget(ctx, pane, target, deps) {
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
    return { ...pane, status: "switched", reason: pane.plan ? planReason(pane.plan) : null };
  } catch (error) {
    const previous = deps.catalog.find((profile) =>
      profile.id === transition.previousProfileId) || pane.currentProfile;
    if (!previous || previous.id === target.id) return { ...pane, status: "failed", reason: error.message };
    setRuntimeProfile(ctx.state, pane.agentName, pane.pane, "claude", previous.id);
    try {
      deps.prepare(previous, deps.catalog);
      await ctx.agent.restartClaudeAccount(pane.agentName, pane.pane, {
        profile: previous,
        resumeSessionId: sessionId,
      });
      completeRuntimeProfileTransition(ctx.state, transition, previous.id);
      return { ...pane, status: "rolled-back", reason: error.message };
    } catch (rollbackError) {
      return { ...pane, status: "failed", reason: `${error.message}; rollback-failed:${rollbackError.message}` };
    }
  }
}

async function observeProject(ctx, panes, target, deps) {
  const observed = [];
  for (const pane of panes) observed.push(await observePane(ctx, pane, deps.catalog, target, deps));
  return { observed, blocked: observed.find((pane) => !pane.allow) };
}

/**
 * WHAT: Moves one project's Claude panes to the target account in the cheapest safe order.
 * WHY: Keeps a switch from paying a full-context cache miss where a compact on the source is cheaper.
 */
async function rotateProject(ctx, agentName, panes, target, deps, { dry, rows, prepareOnce }) {
  let lease = ctx.deliveryQueue.acquireSessionLease?.(agentName);
  if (!lease) {
    rows.push(...blockedProjectRows(panes, `delivery-lease-busy:${agentName}`));
    return;
  }
  try {
    let { observed, blocked } = await observeProject(ctx, panes, target, deps);
    if (blocked) {
      rows.push(...blockedProjectRows(observed, blocked.reason, blocked));
      return;
    }
    let planned = await planPanes(ctx, observed, target, deps);
    if (dry) {
      rows.push(...planned.map((pane) => dryRow(pane, target)));
      return;
    }
    rows.push(...planned.filter((pane) => pane.plan.action === "HOLD").map((pane) => dryRow(pane, target)));
    let movers = planned.filter((pane) => pane.plan.action !== "HOLD");
    if (movers.some((pane) => pane.plan.action === "COMPACT_THEN_RESTART")) {
      lease.release();
      lease = null;
      const compacted = await compactMovers(ctx, movers, deps, rows);
      movers = movers.filter((pane) => pane.plan.action !== "COMPACT_THEN_RESTART" || compacted.has(pane.key));
      lease = ctx.deliveryQueue.acquireSessionLease?.(agentName);
      if (!lease) {
        rows.push(...blockedProjectRows(movers, `delivery-lease-busy-after-compact:${agentName}`));
        return;
      }
      ({ observed, blocked } = await observeProject(ctx, movers, target, deps));
      if (blocked) {
        rows.push(...blockedProjectRows(observed, blocked.reason, blocked));
        return;
      }
      // New work between the compact and this lease can make a context large again; it is not compacted twice.
      planned = await planPanes(ctx, observed, target, deps, compacted);
      const grown = planned.filter((pane) => pane.plan.action === "COMPACT_THEN_RESTART" || pane.plan.action === "HOLD");
      rows.push(...grown.map((pane) => ({ ...pane, status: "blocked",
        reason: `context-changed-before-switch:${planReason(pane.plan)}` })));
      movers = planned.filter((pane) => !grown.includes(pane));
    }
    if (movers.length) await switchPanes(ctx, movers, target, deps, rows, prepareOnce);
  } finally {
    lease?.release();
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
    access: dependencies.access || ((profile) => readClaudeQuotaBudgeted({ profile, refresh: !dry })),
    readContinuity: dependencies.readContinuity || readRotationContinuity,
    assertContinuity: dependencies.assertContinuity || assertRotationContinuity,
    policy: dependencies.policy || readContextCostPolicy(),
    observeContext: dependencies.observeContext || ((context, pane) => observeSwitchContext(context, pane)),
    compactPane: dependencies.compactPane || ((context, compactTarget) => compactBeforeSwitch(context, compactTarget)),
    identityOf: dependencies.identityOf || readClaudeProfileIdentity,
    output: dependencies.output || console.log,
    setExitCode: dependencies.setExitCode || ((code) => { process.exitCode = code; }),
  };
  const target = resolveClaudeAccountTarget(requested, deps.catalog, { identityOf: deps.identityOf });
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

  const rows = [];
  let prepared = false;
  const prepareOnce = () => {
    if (prepared) return;
    deps.prepare(target, deps.catalog);
    prepared = true;
  };
  for (const [agentName, panes] of projectsFor(configuredClaudePanes(deps.agents))) {
    await rotateProject(ctx, agentName, panes, target, deps, { dry, rows, prepareOnce });
  }
  const outcome = accountRotationOutcome(rows);
  const status = dry && outcome.status === "RECOVERED" ? "DRY-RUN" : outcome.status;
  const reason = outcome.status === "BLOCKED" ? "preflight-failed" : null;
  report(deps.output, status, target, rows, reason);
  if (status !== "RECOVERED" && status !== "DRY-RUN") deps.setExitCode(1);
  return { ...outcome, status, ...(reason ? { reason } : {}), rows };
}
