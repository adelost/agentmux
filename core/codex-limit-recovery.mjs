import { readCodexAccountQuota } from "./codex-account-quota.mjs";
import { codexProfileCatalog, selectedCodexProfile, isCodexProfileAuthenticated } from "./codex-profiles.mjs";
import { codexAccountContinuity, switchCodexAccount } from "./codex-account-switch.mjs";
import { driveCodexStatus } from "./codex-status.mjs";
import { codexLastPrompt } from "./codex-refusal-notice.mjs";
import { parseJsonlText, readTailWindow } from "./jsonl-reader.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { findBlockingPrompt } from "./dismiss.mjs";
import { CAPACITY_CONTINUE_TEXT } from "./codex-capacity-recovery.mjs";

const STATE_KEY = "codex_limit_recovery";
const windows = quota => quota?.limits?.find(limit => limit.limitId === "codex")?.windows || [];
const weeklyReached = quota => quota.ok && windows(quota).some(window => window.windowMinutes === 10080 && window.usedPercent >= 100);
const hasRoom = quota => quota.ok && windows(quota).some(window => window.windowMinutes === 10080)
  && windows(quota).every(window => window.usedPercent < 100);

/** WHAT: Builds pane-local account recovery after an actual weekly limit. WHY: Prevents predictions and temporary capacity from switching paid accounts. */
export function createCodexLimitRecovery({ state, broker, agent, notify, log = console.warn,
  enabled = process.env.AMUX_CODEX_LIMIT_RECOVERY_ENABLED !== "false", catalog = codexProfileCatalog(),
  quota = readCodexAccountQuota, continuity = codexAccountContinuity, authenticated = isCodexProfileAuthenticated,
  switchAccount = switchCodexAccount, statusDriver = driveCodexStatus,
  readLatestPrompt = file => codexLastPrompt(parseJsonlText(readTailWindow(file, 256 * 1024).text)) } = {}) {
  const running = new Set();
  const save = (key, value) => state.set(STATE_KEY, { ...state.get(STATE_KEY, {}), [key]: value });
  async function blocked(key, record, reason) {
    save(key, { ...record, phase: "blocked", reason });
    await notify(`⚠️ **${key}** reached a Codex usage limit. Automatic account recovery stopped: ${reason}. Use //switch after resolving continuity.`,
      { name: key.slice(0, key.lastIndexOf(":")), pane: Number(key.slice(key.lastIndexOf(":") + 1)) });
    save(key, { ...record, phase: "blocked", reason, notified: true });
  }
  async function recover({ name, pane, dir, result }) {
    const key = `${name}:${pane}`, refusal = result?.refusals?.at(-1);
    if (!refusal || !/usage limit/iu.test(refusal.reason || "")) return;
    const prior = state.get(STATE_KEY, {})[key];
    if (prior?.id === refusal.id) {
      if (prior.phase === "blocked" && !prior.notified) await blocked(key, prior, prior.reason);
      return;
    }
    const newerInput = prompt => Date.parse(prompt?.timestamp || "") > Date.parse(refusal.timestamp);
    if (newerInput(result.lastPrompt) || broker.queue.list(name, pane).some(job => !TERMINAL_DELIVERY_STATES.has(job.status))) return;
    const transport = await agent.promptTransportState(name, pane, CAPACITY_CONTINUE_TEXT);
    if (transport.dialect !== "codex" || transport.busy || transport.state !== "empty-idle"
        || findBlockingPrompt(await agent.captureScreen(name, pane))) return;
    const current = selectedCodexProfile(state, name, pane, catalog);
    if (!weeklyReached(await quota(current))) { save(key, { id: refusal.id, phase: "not-weekly" }); return; }
    const record = { id: refusal.id, profile: current.id };
    let target, targetQuota;
    for (const candidate of catalog.filter(profile => profile.id !== current.id && authenticated(profile))) {
      const observed = await quota(candidate);
      if (hasRoom(observed)) { target = candidate; targetQuota = observed; break; }
    }
    if (!target) return blocked(key, record, "no authenticated account with verified room");
    const proof = continuity(dir, current, target);
    if (!proof.ok) return blocked(key, record, `continuity: ${proof.reason}`);
    if (newerInput(readLatestPrompt(result.jsonlFile)) || broker.queue.list(name, pane).some(job => !TERMINAL_DELIVERY_STATES.has(job.status))) return;
    const lease = broker.queue.acquireSessionLease(name, pane);
    if (!lease) return;
    try {
      save(key, { ...record, phase: "switching", target: target.id });
      const switched = await switchAccount({ agent, state, name, pane, current, target, continuity: proof,
        expectedEmail: targetQuota.account?.email, statusDriver });
      if (switched.kind !== "switched") return blocked(key, record, switched.error || "switch did not verify");
      const job = broker.enqueue({ agentName: name, pane, text: CAPACITY_CONTINUE_TEXT, source: "codex-limit-recovery",
        idempotencyKey: `codex-limit:${key}:${refusal.id}`, metadata: { capacityEpisode: refusal.id,
          capacityRefusedAt: refusal.timestamp, capacitySessionFile: proof.path || result.jsonlFile } });
      save(key, { ...record, target: target.id, phase: "continued", jobId: job.id });
      log(`${key} weekly limit recovery verified on account ${target.id}; continuation ${job.id}`);
    } finally { lease.release(); }
  }
  async function tick(input) {
    const key = `${input.name}:${input.pane}`;
    if (!enabled || !broker || running.has(key)) return;
    running.add(key);
    try { await broker.runExclusive(input.name, input.pane, () => recover(input)); }
    catch (error) { log(`${key} account recovery failed: ${error.message}`); }
    finally { running.delete(key); }
  }
  return { tick };
}
