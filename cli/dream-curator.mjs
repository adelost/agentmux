import { getPaneStatus } from "./tmux.mjs";
import { readDreamOwnerQuality } from "../core/dream-owner.mjs";
import { latestClaudeSessionIdentity } from "../core/native-session-identity.mjs";
import { verifiedClaudeCompact, verifiedCodexCompact } from "../core/verified-compact.mjs";

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

/** WHAT: Checks one curator's quality and exact compaction. WHY: Prevents dispatch before native session and quality proof. */
export async function prepareDreamOwner(ctx, owner, dependencies) {
  const before = verifyOwnerQuality(owner, await ownerQuality(ctx, owner, dependencies));
  const compact = owner.engine === "codex"
    ? await (dependencies.compactCodex || verifiedCodexCompact)({
        agent: ctx.agent, agentName: owner.agent, pane: owner.pane, paneDir: owner.paneDir,
        sleep: dependencies.sleep,
      })
    : await (dependencies.compactClaude || verifiedClaudeCompact)({
        agent: ctx.agent, agentName: owner.agent, pane: owner.pane, paneDir: owner.paneDir,
        latestIdentity: latestClaudeSessionIdentity, sleep: dependencies.sleep,
      });
  if (!compact.ok) throw new Error(`dream-owner-compact-failed:${compact.reason}`);
  const quality = verifyOwnerQuality(owner, await ownerQuality(ctx, owner, dependencies));
  if ((before.sessionId && before.sessionId !== compact.sessionId)
      || (quality.sessionId && quality.sessionId !== compact.sessionId)) {
    throw new Error("dream-owner-quality-session-mismatch");
  }
  return { compact, quality };
}

