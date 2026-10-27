import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { prepareCodexIdle } from "./codex-tui.mjs";
import { latestCodexSessionIdentity } from "./codex-jsonl-reader.mjs";
import { codexModelOverride, setCodexProfile, setCodexModelOverride, clearCodexModelOverride } from "./codex-profiles.mjs";

/** WHAT: Resolves absolute native status directories, including the home abbreviation.
 * WHY: Keeps display notation from breaking continuity checks and fresh journal lookup. */
function statusDirectory(status) {
  if (typeof status?.directory !== "string") return null;
  const directory = status.directory.replace(/^~(?=\/|$)/u, homedir());
  return isAbsolute(directory) ? resolve(directory) : null;
}

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
  continuity = null, expectedEmail = null, freshHandover = null, identityFor = latestCodexSessionIdentity }) {
  const status = async () => {
    const result = await statusDriver({ agent, name, pane });
    if (result.ok || !["compose", "parse"].includes(result.stage)) return result;
    // The driver cleared only its own /status text. Retry a torn startup
    // frame once, never through new work, a human draft or a modal.
    const input = await agent.promptTransportState?.(name, pane, "");
    return input?.dialect === "codex" && !input.busy && input.state === "empty-idle"
      ? statusDriver({ agent, name, pane }) : result;
  };
  if (target.id === current.id) return { kind: "same", status: await status() };
  if (continuity && !continuity.ok) return { kind: "failed", error: `continuity: ${continuity.reason}` };
  if (freshHandover && (!freshHandover.ok || !freshHandover.path || !freshHandover.text)) return { kind: "failed", error: "fresh account requires a saved handover" };
  const idle = await prepareCodexIdle({ agent, name, pane });
  if (!idle.ok) return { kind: "failed", error: `${idle.stage}: ${idle.error}` };
  const previousOverride = codexModelOverride(state, name, pane);
  const beforeStatus = await status();
  const beforeDirectory = statusDirectory(beforeStatus.status);
  const context = await (agent.getContext?.(name, pane) ?? agent.getContextPercent?.(name, pane));
  const effective = beforeStatus.ok && beforeStatus.status.model?.id
    ? { model: beforeStatus.status.model.id, effort: beforeStatus.status.model.effort }
    : previousOverride || (context?.model ? { model: context.model, effort: context.effort ?? null } : null);
  if ((continuity || freshHandover) && (!beforeStatus.ok || !effective?.model || !beforeDirectory
      || !beforeStatus.status.session || (continuity && beforeStatus.status.session !== continuity.sessionId))) {
    return { kind: "failed", error: "Account unchanged: the pane's model and session could not be confirmed. Check /status. For an empty pane, exit it and pick the account before a fresh Terra start. Save work in progress first." };
  }
  setCodexProfile(state, name, pane, target.id);
  if (effective?.model) setCodexModelOverride(state, name, pane, effective.model, effective.effort);
  try {
    await agent.restartCodex(name, pane, { profile: target, model: effective?.model || null, effort: effective?.effort || null,
      ...(freshHandover ? { newSession: true } : continuity ? { resumeSessionId: continuity.sessionId } : {}) });
    const verified = await status();
    if (!verified.ok) throw new Error(`native status: ${verified.stage}: ${verified.error}`);
    if (effective?.model && (verified.status.model?.id !== effective.model
        || (effective.effort && verified.status.model?.effort !== effective.effort))) throw new Error("account switch changed the requested model or effort");
    if (continuity && verified.status.session !== continuity.sessionId) throw new Error("account switch lost the exact session");
    if (continuity && statusDirectory(verified.status) !== beforeDirectory) throw new Error("account switch changed the working directory");
    const freshIdentity = freshHandover && identityFor(beforeDirectory, { sessionDirs: [join(target.home, "sessions")] });
    // Empty native sessions have no rollout until their first user turn. /status
    // already proves the new UUID, cwd, account and requested model without a paid probe.
    if (freshHandover && (!verified.status.session
        || verified.status.session === beforeStatus.status.session || statusDirectory(verified.status) !== beforeDirectory)) {
      throw new Error("fresh account session identity/directory did not verify");
    }
    const accountEmail = String(verified.status.account || "").match(/[^\s()]+@[^\s()]+/u)?.[0];
    if (expectedEmail && accountEmail !== expectedEmail) throw new Error("the new account identity could not be verified");
    if (verified.status.model?.id) setCodexModelOverride(state, name, pane, verified.status.model.id, verified.status.model.effort);
    return { kind: "switched", status: verified, ...(freshHandover ? { fresh: true, sessionId: verified.status.session, path: freshIdentity?.sessionId === verified.status.session ? freshIdentity.path : null,
      text: freshHandover.text, handoverPath: freshHandover.path } : {}) };
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
        ...(continuity || freshHandover ? { resumeSessionId: continuity?.sessionId || beforeStatus.status.session } : {}) });
    } catch (rollback) { rollbackError = rollback.message; }
    return { kind: "failed", error: error.message, rollbackError };
  }
}
