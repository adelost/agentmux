import { buildCodexLaunchCommand } from "./agent-launch-command.mjs";
import { launchCodexWithPolicy } from "./codex-launch-policy.mjs";
import { parseCodexPaneReading } from "./codex-status.mjs";
import { codexModelOverride, selectedCodexProfile } from "./codex-profiles.mjs";
import { verifiedCodexCompact } from "./verified-compact.mjs";
import { rememberContextCompact } from "./context-maintenance.mjs";
import { esc } from "../lib.mjs";

/** WHAT: Routes process launch through compact-first policy. WHY: Keeps every wake and recovery on the same session-preserving transition. */
export async function startCodexProcess({
  t, wait, target, dir, profile, selected, sessionId, previous, remembered,
  launchOptions, compact, ready, screen, remember, pin,
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
    receipt: launchOptions?.compactReceipt,
    launch: async (choice) => {
      const cmd = buildCodexLaunchCommand({ profileHome: profile.home, ...choice,
        resumeSessionId: sessionId, allowFreshBootstrap: !sessionId });
      await t.runShell(target, `cd ${esc(dir)} && ${cmd}`);
      await wait(500);
      if (!await ready()) throw new Error("Codex composer did not become ready");
    },
    compact,
    reset,
    verify: async () => parseCodexPaneReading(await screen())?.selected,
    remember: (actual) => {
      remember({ sessionId, status: sessionId ? "ready" : "awaiting-first-rollout",
        model: actual.model, effort: actual.effort, modelTransitionBlocked: null });
      pin(actual);
    },
    recordBlocked: (error) => remember({ sessionId, status: "model-change-blocked",
      model: previous?.model || null, effort: previous?.effort || null, modelTransitionBlocked: error }),
  });
}

/** WHAT: Checks work against the selected Codex model. WHY: Prevents a failed compact or fallback from spending the next prompt on another model. */
export async function assertCodexWorkModel({ state, name, pane, configured, screen, prompt = "" }) {
  if (/^\s*\/model(?:\s|$)/u.test(prompt)) throw new Error(`Raw Codex /model bypasses compact: use amux model ${name} -p ${pane} MODEL or Discord /model`);
  if (/^\s*\//u.test(prompt)) return;
  const profile = selectedCodexProfile(state, name, pane);
  const record = state?.get?.("codex_session_by_pane_profile_v1", {})?.[`${name}:${pane}@${profile.id}`];
  if (record?.modelTransitionBlocked) throw new Error(`Codex work blocked: ${record.modelTransitionBlocked.reason}`);
  const expected = codexModelOverride(state, name, pane) || configured;
  const actual = parseCodexPaneReading(await screen())?.selected;
  if (!expected?.model || actual?.model !== expected.model) {
    throw new Error(`Codex work blocked: selected ${expected?.model || "unknown"}, running ${actual?.model || "unknown"}; verify /status before retrying`);
  }
}

/** WHAT: Builds an exact-session compact operation. WHY: Keeps the command and its completion receipt bound to the addressed pane. */
export function createCodexCompact({ control, dirFor, wait, state }) {
  return async (name, pane, { sendCompact } = {}) => {
    const receipt = await verifiedCodexCompact({
      agentName: name, pane, paneDir: dirFor(name, pane), agent: control, sleep: wait,
      ...(sendCompact ? { sendSlash: () => sendCompact() } : {}),
    });
    rememberContextCompact(state, name, pane, receipt);
    return receipt;
  };
}
