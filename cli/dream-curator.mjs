import { getPaneStatus } from "./tmux.mjs";
import { readDreamOwnerQuality } from "../core/dream-owner.mjs";
import { latestClaudeSessionIdentity, latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { verifiedClaudeCompact, verifiedCodexCompact } from "../core/verified-compact.mjs";
import { beginContextCompact, contextMaintenanceAttempt } from "../core/context-maintenance.mjs";
import { updateCompactReceipt } from "../core/compact-receipts.mjs";
import { waitForSessionLease } from "../core/session-lease.mjs";
import { TERMINAL_DELIVERY_STATES } from "../core/delivery-queue-policy.mjs";

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// A pane in one of these states cannot curate tonight no matter how long Dream
// waits: the quota is spent, or a human has to clear something first. Every
// other non-idle state is a pane that is merely busy and will come back.
const CANNOT_CURATE = Object.freeze({
  limited: "quota or rate limited",
  permission: "waiting on a human permission prompt",
  menu: "sitting in a modal menu",
});

/** WHAT: Returns a terminal candidate blocker. WHY: Keeps incapacity separate from a merely busy turn. */
export function dreamCandidateBlocker(status) {
  return CANNOT_CURATE[status] ?? null;
}

/**
 * WHAT: Returns the first capable idle configured curator.
 * WHY: Prevents a transient busy state from silently changing editorial ownership.
 */
export async function selectIdleOwner(ctx, candidates, { ensureReady, prepare, attempts, ...idleOptions } = {}) {
  const skipped = [];
  const reasons = [];
  let lastError = null;
  for (const candidate of candidates) {
    try { await ensureReady(candidate.agent, candidate.pane); }
    catch (error) {
      lastError = error;
      skipped.push(`${candidate.agent}:${candidate.pane}`);
      reasons.push(`${candidate.agent}:${candidate.pane} startup failed: ${error.message}`);
      continue;
    }
    const outcome = await waitForOwnerIdle(ctx, candidate, { ...idleOptions, attempts });
    if (outcome.idle) {
      try { return { owner: candidate, ...(await prepare(candidate)), skipped, reasons }; }
      catch (error) {
        lastError = error;
        skipped.push(`${candidate.agent}:${candidate.pane}`);
        reasons.push(`${candidate.agent}:${candidate.pane} preparation failed: ${error.message}`);
        continue;
      }
    }
    skipped.push(`${candidate.agent}:${candidate.pane}`);
    reasons.push(`${candidate.agent}:${candidate.pane} ${outcome.blocked || "stayed busy for the whole grace period"}`);
    if (!outcome.blocked) break;
  }
  return { owner: null, skipped, reasons, lastError };
}

/** WHAT: Waits only inside the configured grace period. WHY: Busy work and terminal incapacity need different fallback decisions. */
async function waitForOwnerIdle(ctx, owner, {
  attempts = 120, pollMs = 5_000, sleep = wait, getStatus = getPaneStatus,
} = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await getStatus(ctx, owner.agent, owner.pane).catch(() => "unknown");
    if (status === "idle") return { idle: true, blocked: null };
    // Incapacity is visible on the first poll, so giving every candidate the
    // full grace costs a quota-dead pane nothing.
    const blocked = dreamCandidateBlocker(status);
    if (blocked) return { idle: false, blocked };
    if (attempt + 1 < attempts) await sleep(pollMs);
  }
  return { idle: false, blocked: null };
}

/** WHAT: Validates observed curator quality. WHY: Unknown models or low effort cannot authorize curation. */
function verifyOwnerQuality(owner, context) {
  if (!context?.model || !context?.effort) {
    throw new Error(`dream-owner-quality-unverified:${owner.agent}:${owner.pane}`);
  }
  if (/haiku/iu.test(context.model) || String(context.effort || "").toLowerCase() === "low") {
    throw new Error(`dream-owner-quality-blocked:${context.model}:${context.effort || "unknown-effort"}`);
  }
  return {
    model: String(context.model), effort: String(context.effort),
    sessionId: context.sessionId || null, source: context.source || null,
  };
}

/** WHAT: Reads the exact selected pane. WHY: Keeps test IO and native quality evidence on the same seam. */
function ownerQuality(ctx, owner, dependencies) {
  return dependencies.getContext
    ? dependencies.getContext(owner.paneDir, owner.engine)
    : (dependencies.getQuality || readDreamOwnerQuality)(owner, {
        captureScreen: (agent, pane) => ctx.agent.captureScreen(agent, pane),
      });
}

/** WHAT: Routes the curator compact through its exact shared receipt. WHY: Prevents Dream from duplicating another trigger's unresolved attempt. */
async function compactDreamOwner(ctx, owner, dependencies, before) {
  const injected = owner.engine === "codex" ? dependencies.compactCodex : dependencies.compactClaude;
  const compact = injected || (owner.engine === "codex" ? verifiedCodexCompact : verifiedClaudeCompact);
  const options = { agent: ctx.agent, agentName: owner.agent, pane: owner.pane, paneDir: owner.paneDir,
    ...(owner.engine === "claude" && { latestIdentity: latestClaudeSessionIdentity }), sleep: dependencies.sleep };
  // Synthetic provider doubles may be run without a live bridge; production requires the shared store.
  if (!ctx.state && injected) return compact(options);
  const identityFor = dependencies.identityFor || latestPaneSessionIdentity;
  const identity = identityFor(owner.engine, owner.paneDir);
  if (!ctx.state || !ctx.deliveryQueue || !identity?.sessionId || !identity.path
      || before.sessionId && before.sessionId !== identity.sessionId) throw new Error("dream-owner-compact-identity-unavailable");
  const { lease, reason } = await waitForSessionLease(ctx.deliveryQueue, owner.agent, owner.pane);
  if (!lease) throw new Error(`dream-owner-compact-${reason}`);
  let intent;
  try {
    const current = identityFor(owner.engine, owner.paneDir);
    if (current?.sessionId !== identity.sessionId || current.path !== identity.path || await ctx.agent.isBusy(owner.agent, owner.pane)
        || ctx.deliveryQueue.list(owner.agent, owner.pane).some(job => !TERMINAL_DELIVERY_STATES.has(job.status))) {
      throw new Error("dream-owner-compact-session-or-activity-changed");
    }
    const previous = contextMaintenanceAttempt(ctx.state, owner.agent, owner.pane, identity);
    if (previous?.status === "VERIFIED" && previous.compactBoundary) return { ...previous, ok: true };
    if (previous?.status === "VERIFIED") throw new Error("dream-owner-compact-boundary-unverified");
    if (previous) throw new Error(`dream-owner-compact-previous-${previous.status.toLowerCase()}`);
    intent = beginContextCompact(ctx.state, owner.agent, owner.pane, identity, { source: "dream", command: "/compact" });
    const result = await compact({ ...options, onCommandAccepted: () => lease.releaseSession?.() });
    if (!result.ok || !result.compactBoundary || result.sessionId !== identity.sessionId) {
      throw new Error(`dream-owner-compact-failed:${result.reason || "boundary-or-session-mismatch"}`);
    }
    let saved = false;
    updateCompactReceipt(ctx.state, `${owner.agent}:${owner.pane}`, current => {
      if (current.attemptId !== intent.attemptId) return current;
      saved = true;
      return { ...current, status: "VERIFIED", compactBoundary: true, cursor: result.cursor || current.cursor, finishedAt: Date.now() };
    });
    if (!saved) throw new Error("dream-owner-compact-receipt-superseded");
    return result;
  } catch (error) {
    if (intent) updateCompactReceipt(ctx.state, `${owner.agent}:${owner.pane}`, current => current.attemptId === intent.attemptId
      ? { ...current, status: "UNKNOWN", reason: error.message, finishedAt: Date.now() } : current);
    throw error;
  } finally { lease.release(); }
}

/** WHAT: Checks one curator's quality and exact compaction. WHY: Prevents dispatch before native session and quality proof. */
export async function prepareDreamOwner(ctx, owner, dependencies) {
  const before = verifyOwnerQuality(owner, await ownerQuality(ctx, owner, dependencies));
  const compact = await compactDreamOwner(ctx, owner, dependencies, before);
  if (!compact.ok) throw new Error(`dream-owner-compact-failed:${compact.reason}`);
  const quality = verifyOwnerQuality(owner, await ownerQuality(ctx, owner, dependencies));
  if ((before.sessionId && before.sessionId !== compact.sessionId)
      || (quality.sessionId && quality.sessionId !== compact.sessionId)) {
    throw new Error("dream-owner-quality-session-mismatch");
  }
  return { compact, quality };
}
