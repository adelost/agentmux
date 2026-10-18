import { buildCodexLaunchCommand } from "./agent-launch-command.mjs";
import { launchCodexWithPolicy } from "./codex-launch-policy.mjs";
import { parseCodexPaneReading } from "./codex-status.mjs";
import { findBlockingPrompt } from "./dismiss.mjs";
import { codexModelOverride, resolveCodexModelSelection, selectedCodexProfile } from "./codex-profiles.mjs";
import { verifiedCodexCompact } from "./verified-compact.mjs";
import { beginContextCompact, rememberContextCompact } from "./context-maintenance.mjs";
import { latestPaneSessionIdentity } from "./native-session-identity.mjs";
import { esc } from "../lib.mjs";

/** WHAT: Reads the requested live model after startup. WHY: Prevents an early empty composer from masquerading as a fully rendered startup. */
export async function waitForCodexModelSelection({ screen, wait, selected, status, dismiss, attempts = 40 }) {
  let actual = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const frame = await screen();
    const blocker = findBlockingPrompt(frame);
    if (blocker) {
      if (!dismiss) throw new Error(`Codex startup blocked by ${blocker.name}`);
      await dismiss(blocker);
      await wait(blocker.waitMs);
      continue;
    }
    actual = parseCodexPaneReading(frame)?.selected || null;
    if (actual?.model === selected.model && (!selected.effort || actual.effort === selected.effort)) return actual;
    if (attempt + 1 < attempts) await wait(250);
  }
  if (status) {
    const native = await status();
    if (native?.ok && native.status?.model?.id) {
      return { model: native.status.model.id, effort: native.status.model.effort, source: "codex-status" };
    }
    throw new Error(`Codex startup model unverified: ${native?.stage || "status"}: ${native?.error || "no model"}`);
  }
  return actual;
}

/** WHAT: Routes process launch through compact-first policy. WHY: Keeps every wake and recovery on the same session-preserving transition. */
export async function startCodexProcess({
  t, wait, target, dir, profile, selected, sessionId, previous, remembered,
  launchOptions, compact, ready, screen, status, dismiss, remember, pin,
}) {
  const reset = async () => {
    await t.respawnPane(target, { kill: true, cwd: dir });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (/^(bash|zsh|sh|fish|dash)$/.test(await t.currentCommand(target))) return;
      await wait(100);
    }
    throw new Error("Codex replacement shell did not become ready");
  };
  return launchCodexWithPolicy({
    sessionId, previous, selected, blocked: remembered?.modelTransitionBlocked,
    retry: launchOptions?.retryModelChange === true,
    receipt: launchOptions?.compactReceipt, context: launchOptions?.resumeContext, work: launchOptions?.work,
    launch: async (choice, { goals = true, fresh = false } = {}) => {
      const cmd = buildCodexLaunchCommand({ profileHome: profile.home, ...choice,
        resumeSessionId: fresh ? null : sessionId, allowFreshBootstrap: fresh || !sessionId, disableGoals: !goals, cwd: dir });
      await t.runShell(target, `cd ${esc(dir)} && ${cmd}`);
      await wait(500);
      if (!await ready()) throw new Error("Codex composer did not become ready");
    },
    compact,
    reset,
    verify: () => waitForCodexModelSelection({ screen, wait, selected, status, dismiss }),
    remember: (actual, { replacedSessionId = null } = {}) => {
      const current = replacedSessionId ? null : sessionId;
      remember({ sessionId: current, status: current ? "ready" : "awaiting-first-rollout",
        model: actual.model, effort: actual.effort, modelTransitionBlocked: null, supersededSessionId: replacedSessionId });
      pin(actual);
    },
    recordBlocked: (error) => remember({ sessionId, status: "model-change-blocked",
      model: previous?.model || null, effort: previous?.effort || null, modelTransitionBlocked: error }),
  });
}

/** WHAT: Marks a pre-typing refusal. WHY: Lets delivery report the guard's reason instead of a missing receipt. */
function workRefused(message) {
  const error = new Error(message);
  error.code = "AMUX_DELIVERY_REFUSED";
  return error;
}

/**
 * WHAT: Checks work against the selected Codex model.
 * WHY: Prevents a failed compact or fallback from spending the next prompt on another model.
 * The selection is the one a restart would launch (pin, then session history,
 * then config): a lost pin must not turn the fleet default into a veto on
 * the model the pane was deliberately relaunched with.
 */
export async function assertCodexWorkModel({ state, name, pane, configured, screen, previous = null, prompt = "" }) {
  if (/^\s*\/model(?:\s|$)/u.test(prompt)) throw new Error(`Raw Codex /model bypasses compact: use amux model ${name} -p ${pane} MODEL or Discord /model`);
  if (/^\s*\//u.test(prompt)) return;
  const profile = selectedCodexProfile(state, name, pane);
  const record = state?.get?.("codex_session_by_pane_profile_v1", {})?.[`${name}:${pane}@${profile.id}`];
  if (record?.modelTransitionBlocked) throw workRefused(`Codex work blocked: ${record.modelTransitionBlocked.reason}`);
  const override = codexModelOverride(state, name, pane);
  const history = override ? null : await previous?.();
  const expected = resolveCodexModelSelection({ override, configured, previous: history });
  const actual = parseCodexPaneReading(await screen())?.selected;
  if (!expected?.model || actual?.model !== expected.model) {
    throw workRefused(`Codex work blocked: selected ${expected?.model || "unknown"}, running ${actual?.model || "unknown"}; verify /status before retrying`);
  }
}

/** WHAT: Builds an exact-session compact operation. WHY: Keeps the command and its completion receipt bound to the addressed pane. */
export function createCodexCompact({ control, dirFor, wait, state, identityFor = latestPaneSessionIdentity }) {
  return async (name, pane, { sendCompact } = {}) => {
    // The intent is durable before the paid call, so a crash or an unverified
    // outcome is never followed by a second attempt on the same context.
    const identity = identityFor("codex", dirFor(name, pane));
    if (identity?.path) beginContextCompact(state, name, pane, identity);
    const receipt = await verifiedCodexCompact({
      agentName: name, pane, paneDir: dirFor(name, pane), agent: control, sleep: wait,
      ...(sendCompact ? { sendSlash: () => sendCompact() } : {}),
    });
    rememberContextCompact(state, name, pane, receipt);
    return receipt;
  };
}
