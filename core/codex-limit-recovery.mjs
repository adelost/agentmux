import { readCodexAccountQuota } from "./codex-account-quota.mjs";
import { readCodexQuotaBudgeted } from "./codex-quota-budget.mjs";
import { codexProfileCatalog, selectedCodexProfile, isCodexProfileAuthenticated } from "./codex-profiles.mjs";
import { codexAccountContinuity, switchCodexAccount } from "./codex-account-switch.mjs";
import { transferCodexSession } from "./codex-session-transfer.mjs";
import { prepareCodexAccountHandover, freshCodexAccount } from "./codex-account-handover.mjs";
import { driveCodexStatus } from "./codex-status.mjs";
import { codexLastPrompt } from "./codex-refusal-notice.mjs";
import { parseJsonlText, readTailWindow } from "./jsonl-reader.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { findBlockingPrompt } from "./dismiss.mjs";
import { CAPACITY_CONTINUE_TEXT } from "./codex-capacity-recovery.mjs";

const STATE_KEY = "codex_limit_recovery";
const windows = quota => quota?.limits?.find(limit => limit.limitId === "codex")?.windows || [];
/** WHAT: Checks a provider-confirmed exhausted weekly window. WHY: Prevents forecasts and temporary capacity from authorizing account recovery. */
export const codexWeeklyLimitReached = quota => quota?.ok && windows(quota).some(window => window.windowMinutes === 10080 && window.usedPercent >= 100);
/** WHAT: Checks that a Codex account reports a weekly window and room in every window. WHY: Keeps recovery and the idle-capacity alarm on one rule. */
export const codexAccountHasRoom = quota => Boolean(quota?.ok) && windows(quota).some(window => window.windowMinutes === 10080)
  && windows(quota).every(window => window.usedPercent < 100);
const hasRoom = codexAccountHasRoom;

/** WHAT: Builds pane-local account recovery after an actual weekly limit. WHY: Prevents predictions and temporary capacity from switching paid accounts. */
export function createCodexLimitRecovery({ state, broker, agent, notify, log = console.warn,
  enabled = process.env.AMUX_CODEX_LIMIT_RECOVERY_ENABLED !== "false", catalog = codexProfileCatalog(),
  quota = readCodexAccountQuota, deliveryQuota = profile => readCodexQuotaBudgeted(profile, { cacheOnly: true }),
  continuity = codexAccountContinuity, authenticated = isCodexProfileAuthenticated,
  transferSession = transferCodexSession,
  prepareHandover = prepareCodexAccountHandover, freshAccount = freshCodexAccount,
  switchAccount = switchCodexAccount, statusDriver = driveCodexStatus,
  readLatestPrompt = file => codexLastPrompt(parseJsonlText(readTailWindow(file, 256 * 1024).text)) } = {}) {
  const running = new Set();
  const save = (key, value) => state.set(STATE_KEY, { ...state.get(STATE_KEY, {}), [key]: value });
  async function spareAccount(current) {
    for (const target of catalog.filter(profile => profile.id !== current.id && authenticated(profile))) {
      const observed = await quota(target);
      if (hasRoom(observed)) return { target, observed };
    }
    return null;
  }
  // Called inside the broker's existing writer/session lease, never through
  // runExclusive again. The original unsent job is the continuation.
  async function beforeDelivery(job, { dir, lease } = {}) {
    if (!enabled || job.kind !== "prompt") return { ok: true };
    const { agentName: name, pane } = job;
    const transport = await agent.promptTransportState(name, pane, "");
    if (transport.dialect !== "codex") return { ok: true };
    const current = selectedCodexProfile(state, name, pane, catalog);
    if (!codexWeeklyLimitReached(await deliveryQuota(current))) return { ok: true };
    // Cache identifies candidates only. A fresh provider observation must
    // confirm the reached limit before any lifecycle/account mutation.
    if (!codexWeeklyLimitReached(await quota(current))) return { ok: true };
    const hold = reason => ({ ok: false, held: true, reason: `codex-weekly-limit:${reason}` });
    if (!lease || !dir || transport.busy || transport.state !== "empty-idle"
        || findBlockingPrompt(await agent.captureScreen(name, pane))) return hold("not-safe-idle");
    if (broker.queue.list(name, pane).some(other => !TERMINAL_DELIVERY_STATES.has(other.status)
        && (other.id !== job.id ? other.status !== "pending" : !["pending", "delivering"].includes(other.status) || other.draftOwned))) {
      return hold("delivery-in-progress");
    }
    const spare = await spareAccount(current);
    if (!spare) return hold("no-verified-spare-account");
    const proof = transferSession(dir, current, spare.target);
    if (!proof.ok || !continuity(dir, current, spare.target).ok) return hold(proof.reason || "exact-session-unavailable");
    const switched = await switchAccount({ agent, state, name, pane, current, target: spare.target, continuity: proof,
      expectedEmail: spare.observed.account?.email, statusDriver });
    if (switched.kind !== "switched") return hold(switched.error || "switch-did-not-verify");
    save(`${name}:${pane}`, { id: `delivery:${job.id}`, profile: current.id, target: spare.target.id,
      phase: "ready-for-delivery", jobId: job.id, sessionId: proof.sessionId });
    return { ok: true };
  }
  async function blocked(key, record, reason) {
    save(key, { ...record, phase: "blocked", reason });
    await notify(`**${key}** reached a Codex usage limit. Automatic account recovery stopped: ${reason}. Use //switch after resolving continuity.`,
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
    if (!codexWeeklyLimitReached(await quota(current))) { save(key, { id: refusal.id, phase: "not-weekly" }); return; }
    const record = { id: refusal.id, profile: current.id };
    const spare = await spareAccount(current);
    if (!spare) return blocked(key, record, "no authenticated account with verified room");
    const { target, observed: targetQuota } = spare;
    if (newerInput(readLatestPrompt(result.jsonlFile)) || broker.queue.list(name, pane).some(job => !TERMINAL_DELIVERY_STATES.has(job.status))) return;
    const lease = broker.queue.acquireSessionLease(name, pane);
    if (!lease) return;
    try {
      const proof = transferSession(dir, current, target);
      save(key, { ...record, phase: "switching", target: target.id });
      const canResume = proof.ok && continuity(dir, current, target).ok;
      const switched = canResume
        ? await switchAccount({ agent, state, name, pane, current, target, continuity: proof,
          expectedEmail: targetQuota.account?.email, statusDriver })
        : await freshAccount({ agent, state, name, pane, dir, current, target, statusDriver, expectedEmail: targetQuota.account?.email,
          handover: prepareHandover({ name, pane, dir, current, target, refusal }) });
      if (switched.kind !== "switched") return blocked(key, record, switched.error || "switch did not verify");
      const job = broker.enqueue({ agentName: name, pane, text: switched.text || CAPACITY_CONTINUE_TEXT, source: "codex-limit-recovery",
        idempotencyKey: `codex-limit:${key}:${refusal.id}`, metadata: { capacityEpisode: refusal.id,
          capacityRefusedAt: refusal.timestamp, capacitySessionFile: switched.path || proof.path || result.jsonlFile,
          ...(switched.handoverPath ? { handoverPath: switched.handoverPath } : {}) } });
      save(key, { ...record, target: target.id, phase: "continued", fresh: switched.fresh === true, jobId: job.id });
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
  return { tick, beforeDelivery };
}
