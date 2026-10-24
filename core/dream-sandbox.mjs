import { realpathSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { selectedCodexProfile } from "./codex-profiles.mjs";
import { codexComposerText } from "./codex-tui.mjs";
import { dreamSandboxConfig, verifyDreamSandboxProof } from "./dream-sandbox-policy.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue.mjs";

/** DTO: Controller-owned per-pane Dream startup fences. */
export const DREAM_SANDBOX_STATE = "dream_sandbox_v1";

/** WHAT: Returns the persistent restriction for each restart. WHY: Prevents a reboot from resuming an uncertain curator with ordinary full-access flags. */
export function dreamSandboxFor(state, name, pane, sessionId, profileId) {
  const guard = state?.get?.(DREAM_SANDBOX_STATE, {})?.[`${name}:${pane}`];
  if (!guard || guard.status === "terminal") return null;
  if (guard.kernelVerified !== true) throw Error("dream-sandbox-kernel-unattested");
  if (guard.sessionId !== sessionId || guard.profileId !== profileId || realpathSync(guard.root) !== guard.root) throw Error("dream-sandbox-session-mismatch");
  return guard;
}

/** WHAT: Checks the installed kernel boundary before a model turn. WHY: Prevents unsupported or ignored sandbox settings from becoming memory-write authority. */
function probeDreamSandbox(guard, profile) {
  if (readdirSync(guard.root).length) throw Error("dream-sandbox-root-not-empty");
  const deniedPath = `${guard.root}.deny-probe`, allowedPath = join(guard.root, ".sandbox-probe");
  writeFileSync(deniedPath, "controller-owned-probe", { flag: "wx", mode: 0o600 });
  try {
    const script = "const fs=require('node:fs');let denied=false;fs.writeFileSync(process.argv[1],'artifact');try{fs.writeFileSync(process.argv[2],'outside')}catch(e){denied=['EROFS','EACCES','EPERM'].includes(e.code)}process.stdout.write(JSON.stringify({denied}))";
    const result = JSON.parse(execFileSync("codex", ["sandbox", "-P", guard.profile,
      ...dreamSandboxConfig(guard).flatMap(value => ["-c", value]), "--", process.execPath, "-e", script, allowedPath, deniedPath],
    { env: { ...process.env, CODEX_HOME: profile.home }, encoding: "utf8", timeout: 20000, maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] }));
    if (!result.denied || readFileSync(deniedPath, "utf8") !== "controller-owned-probe" || readFileSync(allowedPath, "utf8") !== "artifact") throw Error("dream-sandbox-kernel-not-enforced");
    const proofPath = `${guard.root}.sandbox-proof.json`;
    writeFileSync(proofPath, JSON.stringify({ runId: guard.runId, inputSha256: guard.inputSha256, root: guard.root, profile: guard.profile,
      kernelVerified: true, checkedAt: new Date().toISOString(), modelTurnStarted: false }) + "\n", { flag: "wx", mode: 0o400 });
    return { kernelVerified: true, proofPath };
  } finally {
    unlinkSync(deniedPath);
    try { unlinkSync(allowedPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

/** WHAT: Saves startup after the native model/composer check. WHY: Prevents arming intent alone from authorising a curator result. */
export function markDreamSandboxRunning(state, name, pane, guard) {
  if (!guard) return;
  state.updateKey(DREAM_SANDBOX_STATE, records => {
    const current = records?.[`${name}:${pane}`];
    if (current?.runId !== guard.runId) throw Error("dream-sandbox-run-changed");
    if (current.status !== "terminal") current.status = "running";
    current.startedAt = new Date().toISOString();
    return records;
  });
}

/** WHAT: Checks the idle curator and applies its persistent OS profile. WHY: Keeps source identity, drafts and queue fences intact without a side model process. */
export async function enterDreamSandbox(ctx, owner, input, compact, quality) {
  if (owner.engine !== "codex" || !ctx.state?.updateKey || !ctx.deliveryQueue) throw Error("dream-sandbox-controller-unavailable");
  const lease = ctx.deliveryQueue.acquireSessionLease(owner.agent);
  if (!lease) throw Error("dream-sandbox-session-busy");
  try {
    const pending = ctx.deliveryQueue.list(owner.agent, owner.pane).filter(job => !TERMINAL_DELIVERY_STATES.has(job.status));
    if (pending.length || await ctx.agent.isBusy(owner.agent, owner.pane)
      || codexComposerText(await ctx.agent.captureScreen(owner.agent, owner.pane)) !== "") throw Error("dream-sandbox-active-writer-or-draft");
    const profile = selectedCodexProfile(ctx.state, owner.agent, owner.pane);
    const guard = { ...input.sandbox, runId: input.runId, inputSha256: input.sha256,
      sessionId: compact.sessionId, profileId: profile.id, model: quality.model, effort: quality.effort, status: "armed" };
    if (!guard.root || realpathSync(guard.root) !== guard.root) throw Error("dream-sandbox-invalid-root");
    ctx.state.updateKey(DREAM_SANDBOX_STATE, records => {
      records ||= {};
      const previous = records[`${owner.agent}:${owner.pane}`];
      if (previous && previous.status !== "terminal") throw Error("dream-sandbox-prior-outcome-unknown");
      records[`${owner.agent}:${owner.pane}`] = guard;
      return records;
    });
    const kernel = probeDreamSandbox(guard, profile);
    ctx.state.updateKey(DREAM_SANDBOX_STATE, records => {
      const current = records?.[`${owner.agent}:${owner.pane}`];
      if (current?.runId !== guard.runId) throw Error("dream-sandbox-run-changed");
      Object.assign(current, kernel);
      return records;
    });
    await ctx.agent.restartCodex(owner.agent, owner.pane, { profile, resumeSessionId: compact.sessionId,
      model: quality.model, effort: quality.effort, compactReceipt: compact });
    return verifyDreamSandboxProof(input, ctx.state.get(DREAM_SANDBOX_STATE)?.[`${owner.agent}:${owner.pane}`]);
  } finally { lease.release(); }
}

/** WHAT: Saves native terminal proof on the unfinished-run fence. WHY: Keeps UNKNOWN restricted across another night or restart. */
export function finishDreamSandbox(ctx, owner, input) {
  if (!input.sandbox) return;
  ctx.state.updateKey(DREAM_SANDBOX_STATE, records => {
    const guard = records?.[`${owner.agent}:${owner.pane}`];
    if (guard?.runId !== input.runId) throw Error("dream-sandbox-run-changed");
    guard.status = "terminal";
    return records;
  });
}
