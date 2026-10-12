import { join } from "node:path";
import { prepareCodexIdle } from "./codex-tui.mjs";
import { latestCodexSessionIdentity } from "./codex-jsonl-reader.mjs";
import { codexModelOverride, setCodexProfile, setCodexModelOverride, clearCodexModelOverride } from "./codex-profiles.mjs";

/** WHAT: Checks exact-session availability on both account homes. WHY: Prevents an automatic account switch from bootstrapping a replacement conversation. */
export function codexAccountContinuity(dir, current, target) {
  const before = latestCodexSessionIdentity(dir, { sessionDirs: [join(current.home, "sessions")] });
  const after = before && latestCodexSessionIdentity(dir, { sessionDirs: [join(target.home, "sessions")] });
  return before && after?.sessionId === before.sessionId
    ? { ok: true, sessionId: before.sessionId, path: after.path }
    : { ok: false, reason: "the exact current session is not available on the other account" };
}

/** WHAT: Dispatches the existing pane-local account transition and verification. WHY: Keeps manual and automatic switching on one rollback and model-preserving path. */
export async function switchCodexAccount({ agent, state, name, pane, current, target, statusDriver,
  continuity = null, expectedEmail = null }) {
  const status = () => statusDriver({ agent, name, pane });
  if (target.id === current.id) return { kind: "same", status: await status() };
  if (continuity && !continuity.ok) return { kind: "failed", error: `continuity: ${continuity.reason}` };
  const idle = await prepareCodexIdle({ agent, name, pane });
  if (!idle.ok) return { kind: "failed", error: `${idle.stage}: ${idle.error}` };
  const previousOverride = codexModelOverride(state, name, pane);
  const beforeStatus = await status();
  const context = await (agent.getContext?.(name, pane) ?? agent.getContextPercent?.(name, pane));
  const effective = beforeStatus.ok && beforeStatus.status.model?.id
    ? { model: beforeStatus.status.model.id, effort: beforeStatus.status.model.effort }
    : previousOverride || (context?.model ? { model: context.model, effort: context.effort ?? null } : null);
  if (continuity && (!effective?.model || beforeStatus.status?.session !== continuity.sessionId)) {
    return { kind: "failed", error: "current model/session could not be verified before the account switch" };
  }
  setCodexProfile(state, name, pane, target.id);
  if (effective?.model) setCodexModelOverride(state, name, pane, effective.model, effective.effort);
  try {
    await agent.restartCodex(name, pane, { profile: target, model: effective?.model || null, effort: effective?.effort || null,
      ...(continuity ? { resumeSessionId: continuity.sessionId } : {}) });
    const verified = await status();
    if (!verified.ok) throw new Error(`native status: ${verified.stage}: ${verified.error}`);
    if (effective?.model && (verified.status.model?.id !== effective.model
        || (effective.effort && verified.status.model?.effort !== effective.effort))) throw new Error("account switch changed the requested model or effort");
    if (continuity && verified.status.session !== continuity.sessionId) throw new Error("account switch lost the exact session");
    const accountEmail = String(verified.status.account || "").match(/[^\s()]+@[^\s()]+/u)?.[0];
    if (expectedEmail && accountEmail !== expectedEmail) throw new Error("the new account identity could not be verified");
    if (verified.status.model?.id) setCodexModelOverride(state, name, pane, verified.status.model.id, verified.status.model.effort);
    return { kind: "switched", status: verified };
  } catch (error) {
    let rollbackError = null;
    try {
      const idle = await prepareCodexIdle({ agent, name, pane });
      if (!idle.ok) throw new Error(`blocked to preserve pane input (${idle.stage}: ${idle.error})`);
      setCodexProfile(state, name, pane, current.id);
      const previous = previousOverride || effective;
      if (previous?.model) setCodexModelOverride(state, name, pane, previous.model, previous.effort);
      else clearCodexModelOverride(state, name, pane);
      await agent.restartCodex(name, pane, { profile: current, model: previous?.model || null, effort: previous?.effort || null,
        ...(continuity ? { resumeSessionId: continuity.sessionId } : {}) });
    } catch (rollback) { rollbackError = rollback.message; }
    return { kind: "failed", error: error.message, rollbackError };
  }
}
