// Safe fleet-wide coding-account rotation.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listAgents } from "./config.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue.mjs";
import {
  accountRotationOutcome,
  claudeStartDialog,
  classifyClaudeRotationPane,
} from "../core/account-rotation.mjs";
import { isQuotaFloorHeldJob } from "../core/delivery-wake.mjs";
import { recordCompactCall } from "../core/compact-log.mjs";
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
import { isQuotaParkedJob } from "../core/claude-quota-coordinator.mjs";
import { activeClaudeLimitForTarget } from "../core/claude-quota-target.mjs";
import { assertRotationContinuity, readRotationContinuity } from "../core/rotation-continuity.mjs";
import { accountSwitchPlan } from "../policies/account-switch-cost.mjs";
import { readContextCostPolicy } from "../policies/context-cost.mjs";
import { waitForSessionLease } from "../core/session-lease.mjs";
import { compactBeforeSwitch, observeSwitchContext } from "./account-switch-compact.mjs";

const paneKey = (agentName, pane) => `${agentName}:${pane}`;
// Modes whose switch is only a new selection: an ordinary wake or quota recovery starts the process.
const SELECT_ONLY = new Set(["dormant", "quota-stopped"]);

function configuredClaudePanes(agents) {
  return agents.flatMap((agent) => (agent.panes || []).flatMap((definition, pane) =>
    accountEngineForCommand(definition?.cmd) === "claude"
      ? [{ agentName: agent.name, agent, pane, definition }]
      : []));
}

// A job parked by the pane's own limit waits for its exact-session restart; it is not live delivery
// (2026-10-18 22:33Z: parked messages blocked skyvw, skybar and sandman from Claude S for 5.8 h). Nor is a
// prompt the quota floor holds unsent: it follows the pane and is delivered on the account with room.
function liveDeliveryCount(queue, agentName, pane, { quotaStopped = false } = {}) {
  try {
    return queue.list(agentName, pane)
      .filter((job) => !TERMINAL_DELIVERY_STATES.has(job.status) && !(quotaStopped && isQuotaParkedJob(job))
        && !isQuotaFloorHeldJob(job)).length;
  } catch {
    return NaN;
  }
}

function hasLimitReceipt(deps, agentName, pane) {
  try { return Boolean(deps.limitReceipt(agentName, pane)); }
  catch { return false; }
}

async function observePane(ctx, entry, catalog, target, deps) {
  const { agentName, agent, pane, definition } = entry;
  const paneDir = join(agent.dir, ".agents", String(pane));
  const pending = pendingRuntimeProfile(ctx.state, agentName, pane);
  const currentProfile = selectedRuntimeProfile({ state: ctx.state, agentName, pane,
    paneConfig: definition, provider: "claude", catalog });
  // KEEP has no process or session side effects, so activity on that pane is not a rotation gate.
  if (onTargetAccount({ pending, currentProfile }, target, deps.identityOf)) {
    return { ...entry, key: paneKey(agentName, pane), paneDir, pending, currentProfile,
      allow: true, mode: "keep", reason: "already-selected" };
  }
  const processState = await ctx.agent.paneProcessState(agentName, pane).catch(() => null);
  const running = processState?.running === true;
  const [busy, transport] = running
    ? await Promise.all([
      ctx.agent.isBusy(agentName, pane).catch(() => null),
      ctx.agent.promptTransportState(agentName, pane, "").catch(() => null),
    ])
    : [null, null];
  const identity = running || pending ? deps.latestIdentity(paneDir) : null;
  const quotaStopped = hasLimitReceipt(deps, agentName, pane);
  const liveDeliveryJobs = liveDeliveryCount(ctx.deliveryQueue, agentName, pane, { quotaStopped });
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
    quotaStopped,
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
  if (verdict.allow && !SELECT_ONLY.has(verdict.mode) && !continuity) {
    verdict = { allow: false, mode: "blocked", reason: continuityError || "rotation-session-unproven" };
  }
  const dialog = verdict.allow ? deps.startDialog(currentProfile, target, paneDir) : null;
  if (dialog) verdict = { allow: false, mode: "blocked", reason: `target-start-dialog:${dialog}` };
  return {
    ...entry,
    key: paneKey(agentName, pane),
    paneDir,
    processState,
    identity,
    continuity,
    pending,
    currentProfile,
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

function blockedProjectRows(panes, reason) {
  return panes.map((pane) => ({ ...pane, key: pane.key || paneKey(pane.agentName, pane.pane), status: "blocked", reason }));
}

/** WHAT: Reads a JSON file once per rotation. WHY: Keeps a profile's large state file from being parsed once per pane. */
function cachedJsonReader() {
  const cache = new Map();
  return (path) => {
    if (!path) return null;
    if (!cache.has(path)) {
      try { cache.set(path, JSON.parse(readFileSync(path, "utf8"))); } catch { cache.set(path, null); }
    }
    return cache.get(path);
  };
}

function paneChangeReason(before, after, deps) {
  if (!after.allow) return after.reason;
  if (after.currentProfile?.id !== before.currentProfile?.id) return "rotation-profile-changed";
  if (after.mode !== before.mode) return "rotation-pane-changed";
  if (after.pending?.sessionId !== before.pending?.sessionId
      || after.pending?.targetProfileId !== before.pending?.targetProfileId) {
    return "rotation-transition-changed";
  }
  if (SELECT_ONLY.has(before.mode) || before.mode === "keep") return null;
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
const DRY_STATUS = { SELECT: (pane) => (pane.mode === "quota-stopped" ? "would-select-for-quota-recovery" : `would-${pane.mode}`),
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
    planned.push({ ...pane, plan, compactTarget: context?.target || null, contextTokens: context?.facts?.tokens ?? null });
  }
  return planned;
}

/** WHAT: Compacts the warm large panes on their source outside the project lease. WHY: Keeps the compact on its own pane lease and an unverified receipt from moving the pane. */
async function compactMovers(ctx, movers, deps, rows) {
  const compacted = new Set();
  for (const pane of movers.filter((candidate) => candidate.plan.action === "COMPACT_THEN_RESTART")) {
    const result = await deps.compactPane(ctx, pane.compactTarget).catch((error) => ({ ok: false, reason: error.message }));
    deps.recordCompact({ at: new Date().toISOString(), pane: pane.key, engine: "claude", source: "account-switch",
      outcome: result.ok ? result.status || "compacted" : "failed", reason: result.reason || null,
      beforeTokens: pane.contextTokens, afterTokens: result.afterTokens ?? null,
      account: pane.currentProfile?.label || pane.currentProfile?.key || null });
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
  const unchanged = observed.filter((pane, index) => {
    const reason = paneChangeReason(pane, recheckedProject[index], deps);
    if (reason) rows.push({ ...pane, status: "blocked", reason });
    return !reason;
  });
  for (const pane of unchanged) {
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
    if (SELECT_ONLY.has(pane.mode)) {
      setRuntimeProfile(ctx.state, pane.agentName, pane.pane, "claude", target.id);
      rows.push({ ...pane, status: pane.mode === "dormant" ? "selected-for-next-wake" : "selected-for-quota-recovery",
        reason: null });
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

// lsrc:0 for Mattias 2026-10-21: a busy pane blocked its idle siblings (lsrc:1/2 behind lsrc:0, api:1/2 behind api:0).
// Each candidate holds the session writer and its own pane fence through every mutation.
/** WHAT: Observes a project's panes and reports each one that cannot move. WHY: Keeps a busy pane from holding its siblings on a spent account. */
async function observeProject(ctx, panes, target, deps, rows) {
  const observed = [];
  for (const pane of panes) observed.push(await observePane(ctx, pane, deps.catalog, target, deps));
  rows.push(...observed.filter((pane) => !pane.allow).map((pane) => ({ ...pane, status: "blocked" })));
  return observed.filter((pane) => pane.allow);
}

/**
 * WHAT: Moves one project's Claude panes to the target account in the cheapest safe order.
 * WHY: Keeps a switch from paying a full-context cache miss where a compact on the source is cheaper.
 */
async function rotateProject(ctx, agentName, panes, target, deps, { dry, rows, prepareOnce }) {
  const deadline = performance.now() + (dry ? 0 : deps.leaseWaitMs);
  for (const candidate of panes) {
    await rotateCandidate(ctx, agentName, [candidate], target, deps, {
      dry, rows, prepareOnce, waitMs: () => Math.max(0, deadline - performance.now()),
    });
  }
}

async function rotateCandidate(ctx, agentName, panes, target, deps, { dry, rows, prepareOnce, waitMs }) {
  const acquire = () => waitForSessionLease(ctx.deliveryQueue, agentName, panes[0].pane,
    { timeoutMs: waitMs(), ...(deps.leaseSleep ? { sleep: deps.leaseSleep } : {}) });
  let acquired = await acquire(), lease = acquired.lease;
  if (!lease) {
    rows.push(...blockedProjectRows(panes, acquired.reason));
    return;
  }
  try {
    let observed = await observeProject(ctx, panes, target, deps, rows);
    if (!observed.length) return;
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
      acquired = await acquire(); lease = acquired.lease;
      if (!lease) {
        rows.push(...blockedProjectRows(movers, acquired.reason.replace("delivery-lease-busy:", "delivery-lease-busy-after-compact:")));
        return;
      }
      observed = await observeProject(ctx, movers, target, deps, rows);
      if (!observed.length) return;
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
  // The quota stop mover moves only the panes its stopped account holds.
  only = null,
} = {}, dependencies = {}) {
  const deps = {
    agents: dependencies.agents || listAgents(ctx.configPath),
    leaseWaitMs: dependencies.leaseWaitMs ?? 30_000,
    leaseSleep: dependencies.leaseSleep,
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
    recordCompact: dependencies.recordCompact || recordCompactCall,
    startDialog: dependencies.startDialog || ((readJson) => (source, target, cwd) =>
      claudeStartDialog({ source, target, cwd, readJson }))(cachedJsonReader()),
    limitReceipt: dependencies.limitReceipt || ((agentName, pane) => (ctx.configPath
      ? activeClaudeLimitForTarget(agentName, pane, { configPath: ctx.configPath }) : null)),
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
  const chosen = configuredClaudePanes(deps.agents).filter((pane) => !only || only.includes(paneKey(pane.agentName, pane.pane)));
  for (const [agentName, panes] of projectsFor(chosen)) {
    await rotateProject(ctx, agentName, panes, target, deps, { dry, rows, prepareOnce });
  }
  const outcome = accountRotationOutcome(rows);
  const status = dry && outcome.status === "RECOVERED" ? "DRY-RUN" : outcome.status;
  const reason = outcome.status === "BLOCKED" ? "preflight-failed" : null;
  report(deps.output, status, target, rows, reason);
  if (status !== "RECOVERED" && status !== "DRY-RUN") deps.setExitCode(1);
  return { ...outcome, status, ...(reason ? { reason } : {}), rows };
}
