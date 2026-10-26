import { warmQuotaHold, claimQuotaCompact, finishQuotaCompact, blocksQuotaCompact } from "./quota-floor-compact.mjs";
import { contextCostDecision, readContextCostPolicy, workAdmission } from "../policies/context-cost.mjs";
import { recordCompactCall } from "./compact-log.mjs";
import { isOwnerChannelJob } from "./ask-origin.mjs";
import { SELF_COMPACT_POLICY, formatSelfCompactNotice, selfCompactAdmission } from "./self-compact.mjs";
import { latestConversationActivityMs } from "./pane-activity.mjs";
import { latestPaneSessionIdentity } from "./native-session-identity.mjs";
import { captureJsonlAppendCursor, hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { verifiedClaudeCompact, verifiedCodexCompact } from "./verified-compact.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { prepareCodexIdle } from "./codex-tui.mjs";
import { getContextPercent } from "./context.mjs";
import { hasEmptyClaudeEpoch } from "./claude-empty-epoch.mjs";
import { codexPromptProgress } from "./codex-user-events.mjs";
import { regainSessionLease } from "./session-lease.mjs";
import { finishSelfCompactRequest, selfCompactSuperseded } from "./self-compact-resume.mjs";
import { isCodexCompaction } from "./codex-compaction.mjs";
import { isRecoveredClaudeCompactAttempt } from "./claude-quota-target.mjs";
import { claudeRefusalResetAt } from "./claude-limit-evidence.mjs";
import { QUOTA_PARK_ORIGIN } from "./quota-park.mjs";
import { QUOTA_WIND_DOWN_ORIGIN } from "./quota-wind-down.mjs";
import { withdrawDraft } from "./draft-withdrawal.mjs";
import { assertDeliveryPreparation, onUnsentPreparationTimeout } from "./delivery-preparation.mjs";

const STATE_KEY = "context_maintenance_by_pane_v1";
const paneKey = (name, pane) => `${name}:${pane}`;
// The longest compact wait (Codex, 1 920 polls of 1 s) plus a margin: no live writer owns an older attempt.
const COMPACT_WRITER_LIFETIME_MS = 40 * 60_000;
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** WHAT: Tells whether the process that began a compact attempt has stopped. WHY: Only then may another pass touch what it typed. */
function compactWriterGone(record, { now, alive, self = process.pid }) {
  if (record.pid === self) return false;
  if (record.pid && !alive(record.pid)) return true;
  return now - record.at > COMPACT_WRITER_LIFETIME_MS;
}

/** WHAT: Reads the compact attempts whose writer is not gone by the compact rule. WHY: Lets the restart gate stop for live work, never for a marker its writer left behind. */
export function liveCompactAttempts(state, { now = Date.now(), alive = processAlive, self = process.pid } = {}) {
  return Object.entries(state.get(STATE_KEY, {}))
    .filter(([, record]) => record.status === "ATTEMPTING" && !compactWriterGone(record, { now, alive, self }))
    .map(([pane, record]) => ({ pane, pid: record.pid, at: record.at }));
}
const compactEvent = e => isCodexCompaction(e)
  || (e?.type === "system" && e.subtype === "compact_boundary");
// Claude journals a typed slash command ("/compact", "/model x") as its own
// user row. A command is not work: counting it let a quota-refused /compact
// re-arm its own fence, so a bridge restart warned and tried again (lsrc:2,
// 2026-09-27). A path such as "/tmp/x is broken" is still a prompt.
const isSlashCommand = text => /^\s*\/[a-z][\w:-]*(?:\s|$)/iu.test(text);
const isClaudeWorkText = text => !/^\s*<(?:local-command|command-)/u.test(text) && !isSlashCommand(text);
const claudeWorkEvent = e => e?.type === "user" && !e.isMeta && !e.isCompactSummary
  && (typeof e.message?.content === "string" ? isClaudeWorkText(e.message.content)
    : e.message?.content?.some(part => part.type === "text"));
// A Codex prompt is work once a model ran on it or while its turn is open.
// One the provider refused (an unsupported model) added nothing to compact.
function hasWorkAfter(files, cursor) {
  const prompts = codexPromptProgress();
  return hasJsonlEventAfterCursor(files, cursor, e => claudeWorkEvent(e) || prompts.see(e) === "processed")
    || prompts.isOpen();
}

function write(state, key, record) {
  assertDeliveryPreparation();
  state.set(STATE_KEY, { ...state.get(STATE_KEY, {}), [key]: record });
}

/** WHAT: Stores verified compact evidence from another maintenance path. WHY: Prevents model switching and cold-wake protection from compacting the same context twice. */
export function rememberContextCompact(state, name, pane, receipt) {
  // "Nothing to compact" leaves the context as small as a compact would: no attempt is due before new work.
  if (!state || !(receipt?.ok || receipt?.nothingToCompact)) return;
  write(state, paneKey(name, pane), { sessionId: receipt.sessionId, cursor: receipt.cursor, status: "VERIFIED", at: Date.now() });
}

/** WHAT: Reads when amux last tried to compact a pane, whatever the outcome. WHY: Keeps pause compaction at most once per spacing window. */
export function lastContextCompactAt(state, name, pane) {
  const record = state?.get?.(STATE_KEY, {})?.[paneKey(name, pane)];
  return record && record.status !== "NOT_SENT" && Number.isFinite(record.at) ? record.at : null;
}

/** WHAT: Reads the current context-generation fence. WHY: Keeps warm, cold and nightly maintenance from repeating a paid attempt without new work. */
export function contextMaintenanceAttempt(state, name, pane, identity = null, now = Date.now()) {
  const record = state?.get?.(STATE_KEY, {})?.[paneKey(name, pane)];
  if (!record || record.status === "NOT_SENT" || (identity && record.sessionId !== identity.sessionId)) return null;
  const files = Object.keys(record.cursor?.positions || {});
  if (!files.length || hasWorkAfter(files, record.cursor)) return null;
  if (record.status !== "VERIFIED" && hasJsonlEventAfterCursor(files, record.cursor, compactEvent)) {
    const verified = { ...record, status: "VERIFIED" };
    write(state, paneKey(name, pane), verified);
    return verified;
  }
  // A compact the provider's usage limit refused spent nothing, so its fence ends when that limit resets.
  if (record.status === "FAILED" && now >= record.retryAt) return null;
  return record;
}

/** WHAT: Stores a maintenance intent before the model call. WHY: Prevents a crash or an ambiguous compact from becoming permission to spend again. */
export function beginContextCompact(state, name, pane, identity) {
  if (!state) return;
  const cursor = captureJsonlAppendCursor("context-maintenance-v1", [identity.path]);
  write(state, paneKey(name, pane), { sessionId: identity.sessionId, cursor, status: "ATTEMPTING", at: Date.now(), pid: process.pid });
}

/** WHAT: Builds shared warm and cold context protection. WHY: Keeps paid compact attempts durable, serialized and bound to exact session evidence. */
export function createContextMaintenance({ agent, state, queue, resolveTarget, now = Date.now, log = () => {}, policy = readContextCostPolicy(),
  recordCompact = recordCompactCall, accountOf = async () => null,
  identityFor = latestPaneSessionIdentity, activityFor = latestConversationActivityMs, journalFor = getContextPercent,
  compactFor = engine => engine === "codex" ? verifiedCodexCompact : verifiedClaudeCompact, coldBeforeDelivery = null,
  selfRequests = null, notify = async () => {}, quotaRecoveryFor = () => ({ options: { queue } }), writerAlive = processAlive }) {
  const existing = (name, pane, identity) => contextMaintenanceAttempt(state, name, pane, identity, now());

  // skyvw:3 2026-10-20 12:23Z: a bridge restart ended the idle compact between typing /compact and its Enter. Its intent
  // stayed ATTEMPTING and the command stayed in the composer, so every delivery was refused for 50 minutes. A command
  // still in the composer was provably never sent: erase it and let the policy decide again.
  async function withdrawAbandonedCompact(name, pane, record) {
    const { outcome } = await withdrawDraft({ agent, job: { agentName: name, pane, text: record.command || "/compact" } });
    if (outcome !== "cleared") return record;
    write(state, paneKey(name, pane), { ...record, status: "NOT_SENT", reason: "abandoned-before-submit", finishedAt: now() });
    finishQuotaCompact(state, record.quotaClaim, "not-sent", "abandoned-before-submit", now());
    log(`${name}:${pane} erased the compact command a stopped writer left unsent; the policy decides again`);
    return null;
  }

  // skyvw:0 2026-10-11: lsrc:4 (370k) and lsrc:5 (310k) got new work after 50
  // idle minutes and started on a cold Codex cache; the 60-minute, 210k cold
  // rule let them through. A pane idle past its own cache's life is compacted
  // before the delivery too, unless a subagent or terminal still works for it.
  function coldPolicyFor(name, pane, target, identity, facts) {
    const rule = coldBeforeDelivery?.limits(target.engine);
    const mode = coldBeforeDelivery?.mode(target.engine) || "off";
    if (!rule || mode === "off") return policy;
    const early = { ...policy, coldMs: rule.idleMs, coldMaxTokens: rule.tokens };
    const changed = contextCostDecision(facts, early);
    if (changed.cell === "within-policy" || contextCostDecision(facts, policy).cell !== "within-policy") return policy;
    const background = changed.values.action === "COMPACT" ? coldBeforeDelivery.background({ engine: target.engine,
      sessionPath: identity.path, sessionId: identity.sessionId, paneDir: target.dir, now: now() }) : null;
    const outcome = changed.values.action !== "COMPACT" ? "held" : background ? "held" : mode === "on" ? "compacting" : "would-compact";
    try {
      coldBeforeDelivery.record({ at: new Date(now()).toISOString(), pane: `${name}:${pane}`, mode, tokens: facts.tokens, limit: rule.tokens,
        quietSec: Math.round(facts.idleMs / 1000), cell: "before-delivery", outcome,
        detail: background || (changed.values.action === "COMPACT" ? `idle ${Math.round(facts.idleMs / 60_000)} min > ${rule.idleMs / 60_000}` : changed.cell) });
    } catch { /* the log is evidence, not control */ }
    return mode === "on" && outcome === "compacting" ? early : policy;
  }
  const canAttempt = (name, pane, sessionId) => Boolean(selfRequests?.read(name, pane)) || !existing(name, pane, sessionId ? { sessionId } : null);
  const selfRequestSuperseded = request => selfCompactSuperseded(request, { identityFor, queue });
  const finishSelfRequest = (request, ending) => finishSelfCompactRequest(request, ending,
    { store: selfRequests, queue, identityFor, receiptFor: existing });

  // A Claude session right after a compact has no token reading yet. When its
  // epoch is provably empty and the pane is still that session, idle and
  // empty, there is nothing to compact before the delivery.
  async function isEmptyEpochStillIdle(name, pane, target, identity) {
    if (target.engine !== "claude" || !await hasEmptyClaudeEpoch(identity)) return false;
    const current = identityFor(target.engine, target.dir);
    const transport = await agent.promptTransportState(name, pane, "").catch(() => null);
    return current?.sessionId === identity.sessionId && current.path === identity.path
      && !await agent.isBusy(name, pane) && transport?.state === "empty-idle";
  }

  // pauseTokens: compact at a natural pause above this budget. dry: run every check, then stop before the paid compact.
  // focus: what a self-requested Claude compact should keep (Codex's /compact takes no focus).
  // beforeDelivery: the broker holds the pane for a waiting job, so queued jobs do not count as in flight.
  async function run(name, pane, { cold = false, pauseTokens = null, pauseSettleMs, dry = false, leaseHeld = false, heldLease = null,
    jobId = null, focus = "", beforeDelivery = cold, required = false } = {}) {
    const target = resolveTarget(name, pane);
    if (!target || !["claude", "codex"].includes(target.engine)) return { ok: true, skipped: "unsupported-engine" };
    if (typeof agent.paneProcessState !== "function" || (await agent.paneProcessState(name, pane).catch(() => null))?.running !== true) {
      return { ok: !cold, skipped: "not-running", reason: "context-cost:not-running" };
    }
    const identity = identityFor(target.engine, target.dir);
    if (!identity) return { ok: true, skipped: "no-session" };
    const ended = state?.get?.(STATE_KEY, {})?.[paneKey(name, pane)];
    if (ended?.status === "NOT_SENT") finishQuotaCompact(state, ended.quotaClaim, "not-sent", ended.reason, now());
    let prior = existing(name, pane, identity);
    if (prior?.status === "ATTEMPTING" && compactWriterGone(prior, { now: now(), alive: writerAlive })) {
      prior = await withdrawAbandonedCompact(name, pane, prior);
    }
    if (prior?.status === "VERIFIED") {
      finishQuotaCompact(state, prior.quotaClaim, "verified", "native-receipt", now());
      return { ok: true, cell: "receipt-exists" };
    }
    const context = await (agent.getContext?.(name, pane) ?? agent.getContextPercent(name, pane));
    let activity = activityFor(target.dir, target.engine, { recoverCodexHistory: true });
    if (!Number.isFinite(activity)) {
      const usage = journalFor(target.dir, target.engine, { journalOnly: true });
      activity = usage?.source?.endsWith("-jsonl") ? Date.parse(usage.observedAt) : NaN;
    }
    // Names what holds the pane, e.g. "pasting" for a composer held by Claude's clipboard lookup.
    const input = await agent.isBusy(name, pane) ? "busy"
      : (await agent.promptTransportState(name, pane, "").catch(() => null))?.state || "unreadable";
    const safe = input === "empty-idle";
    if (prior && safe && target.engine === "claude"
        && isRecoveredClaudeCompactAttempt(name, pane, prior, { ...quotaRecoveryFor(name, pane), now: now() })) {
      write(state, paneKey(name, pane), { ...prior, status: "NOT_SENT", reason: "quota-window-recovered", recoveredAt: now() });
      prior = null;
    }
    const attempt = prior ? "FAILED" : "NEW";
    const facts = { tokens: context?.tokens, idleMs: Number.isFinite(activity) ? now() - activity : NaN, cold, pauseTokens,
      ...(pauseSettleMs != null ? { pauseSettleMs } : {}), safe, attempt, required };
    let coldPolicy = policy;
    try { if (cold) coldPolicy = coldPolicyFor(name, pane, target, identity, facts); }
    catch (error) { log(`${name}:${pane} compact-before-delivery check failed, delivering by the 60-minute rule: ${error.message}`); }
    const decision = contextCostDecision(facts, coldPolicy);
    if (decision.values.action === "CONTINUE") return { ok: true, cell: decision.cell };
    if (cold && decision.cell === "unknown-evidence" && attempt === "NEW" && safe && !Number.isFinite(context?.tokens)
        && await isEmptyEpochStillIdle(name, pane, target, identity)) {
      return { ok: true, cell: "empty-after-compact" };
    }
    const holder = decision.cell === "not-idle" ? `:${input}` : "";
    // need says whether the policy required a compact that did not settle, for the work admission.
    const need = decision.at.need;
    if (decision.values.action === "HOLD") return { ok: false, need, reason: `context-cost:${decision.cell}${holder}${prior?.reason ? `:${prior.reason}` : ""}` };
    const warmMs = target.engine === "codex" ? 30 * 60_000 : policy.coldMs;
    const quota = !cold && Number.isFinite(activity) && now() < activity + warmMs
      ? warmQuotaHold(state, name, pane, queue.list(name, pane)) : null;
    const result = await compactOnce({ name, pane, target, identity, context, decision, dry, leaseHeld, heldLease, jobId, focus, beforeDelivery,
      quota: quota && { ...quota, expiresAt: activity + warmMs } });
    if (cold && coldPolicy !== policy) {
      try { coldBeforeDelivery.record({ at: new Date(now()).toISOString(), pane: `${name}:${pane}`, cell: "before-delivery",
        outcome: result.compacted ? "compacted" : result.dry ? "would-compact" : "failed", detail: result.reason || result.cell || null }); }
      catch { /* diagnostics never change delivery truth */ }
    }
    return result.ok ? result : { ...result, need };
  }

  // Sends one compact under the session lease, with its intent stored before the paid call.
  async function compactOnce({ name, pane, target, identity, context, decision, dry, leaseHeld, heldLease, jobId, focus, beforeDelivery, quota }) {
    const lease = leaseHeld ? null : queue.acquireSessionLease(name, pane);
    if (!leaseHeld && !lease) return { ok: false, reason: "delivery-lease-busy" };
    // Once the command is sent only this pane stays fenced, so its siblings
    // are served during a compact that can take minutes.
    const writer = lease ?? heldLease;
    const pending = () => {
      if (quota && now() >= quota.expiresAt) return true;
      const jobs = queue.list(name, pane);
      const held = quota && now() < quota.expiresAt ? warmQuotaHold(state, name, pane, jobs) : null;
      return jobs.some(j => !TERMINAL_DELIVERY_STATES.has(j.status)
        && blocksQuotaCompact(j, { jobId, beforeDelivery, hold: held?.id === quota?.id ? held : null }));
    };
    let submitted = false, intent = null, quotaClaim = null;
    try {
      const currentAttempt = existing(name, pane, identity);
      if (currentAttempt) return currentAttempt.status === "VERIFIED"
        ? { ok: true, cell: "receipt-exists" }
        : { ok: false, reason: `context-cost:prior-${currentAttempt.status.toLowerCase()}:${currentAttempt.reason || "outcome-unknown"}` };
      if (pending()) {
        return { ok: false, reason: "context-cost:delivery-pending" };
      }
      const current = identityFor(target.engine, target.dir);
      if (current?.sessionId !== identity.sessionId || await agent.isBusy(name, pane)) return { ok: false, reason: "context-cost:session-or-activity-changed" };
      const background = quota && coldBeforeDelivery?.background({ engine: target.engine, sessionPath: identity.path,
        sessionId: identity.sessionId, paneDir: target.dir, now: now() });
      if (background) return { ok: false, reason: `context-cost:${background}` };
      if (dry) return { ok: true, dry: true, cell: decision.cell, tokens: context.tokens };
      if (target.engine === "codex") {
        const idle = await prepareCodexIdle({ agent, name, pane });
        if (!idle.ok) return { ok: false, reason: `context-cost:${idle.stage}:${idle.error}` };
      }
      if (quota) {
        const currentHold = warmQuotaHold(state, name, pane, queue.list(name, pane));
        if (currentHold?.id !== quota.id) return { ok: false, reason: "context-cost:delivery-pending:quota-episode-changed" };
        if (currentHold.attempts.some(attempt => ["attempting", "unknown"].includes(attempt.status))) {
          return { ok: false, reason: "context-cost:delivery-pending:quota-floor-compact-unknown" };
        }
        if (currentHold.attempts.length >= 2) return { ok: false, reason: "context-cost:delivery-pending:quota-floor-compact-limit:2/2" };
        quotaClaim = claimQuotaCompact(state, quota, identity.sessionId, now());
        if (!quotaClaim) return { ok: false, reason: "context-cost:delivery-pending:quota-floor-compact-budget-unavailable" };
      }
      const cursor = captureJsonlAppendCursor("context-maintenance-v1", [identity.path]);
      const command = focus && target.engine === "claude" ? `/compact ${focus}` : "/compact";
      // pid and command let the next pass erase what this attempt typed if this process stops before its Enter.
      const record = { sessionId: identity.sessionId, cursor, status: "ATTEMPTING", at: now(), cell: decision.cell, beforeTokens: context.tokens,
        pid: process.pid, command, ...(quotaClaim && { quotaClaim }) };
      intent = record;
      write(state, paneKey(name, pane), record);
      onUnsentPreparationTimeout(error => {
        const close = (records = {}) => {
          const key = paneKey(name, pane), current = records[key];
          return current?.status === "ATTEMPTING" && current.pid === record.pid && current.at === record.at && current.sessionId === record.sessionId
            ? { ...records, [key]: { ...current, status: "NOT_SENT", reason: error.message, finishedAt: now() } } : records;
        };
        if (state.updateKey) state.updateKey(STATE_KEY, close);
        else state.set(STATE_KEY, close(state.get(STATE_KEY, {})));
      });
      const compact = compactFor(target.engine);
      const guardedAgent = { ...agent, sendOnly: async (agentName, text, index, options) => {
        const guard = async stage => {
          assertDeliveryPreparation();
          const latest = identityFor(target.engine, target.dir);
          const input = await agent.promptTransportState(name, pane, stage === "submit" ? text : "");
          const background = quota && coldBeforeDelivery?.background({ engine: target.engine, sessionPath: identity.path,
            sessionId: identity.sessionId, paneDir: target.dir, now: now() });
          if (background) throw new Error(`context-cost:${background}`);
          if (latest?.sessionId !== identity.sessionId || pending() || await agent.isBusy(name, pane)
              || input?.state !== (stage === "submit" ? "drafted" : "empty-idle")) throw new Error("context-cost:pre-submit-state-changed");
          assertDeliveryPreparation();
        };
        await guard("paste");
        return agent.sendOnly(agentName, text, index, { ...options, existingOnly: true, maintenanceGuard: guard,
          onSubmitting: async () => { submitted = true; await options?.onSubmitting?.(); } });
      } };
      const result = await compact({ agent: guardedAgent, agentName: name, pane, paneDir: target.dir,
        latestIdentity: dir => identityFor(target.engine, dir), maxRescues: 0, command,
        onCommandAccepted: () => writer?.releaseSession?.() });
      // A usage limit refused the compact before it spent anything; it may run again once that limit resets.
      const retryAt = result.reason === "provider-usage-limited" ? claudeRefusalResetAt(result.detail, now()) : null;
      write(state, paneKey(name, pane), { ...record, status: result.ok ? "VERIFIED" : "FAILED", reason: result.reason || null, finishedAt: now(),
        ...(retryAt ? { retryAt } : {}) });
      finishQuotaCompact(state, quotaClaim, result.ok ? "verified" : result.reason === "provider-usage-limited" ? "refused" : "unknown", result.reason, now());
      log(`${name}:${pane} ${decision.cell}: ${result.ok ? "compact verified" : result.reason}`);
      const after = result.ok ? await Promise.resolve(agent.getContext?.(name, pane)).catch(() => null) : null;
      recordCompact({ at: new Date(now()).toISOString(), pane: paneKey(name, pane), engine: target.engine, source: "bridge", cell: decision.cell,
        outcome: result.ok ? "compacted" : "failed", reason: result.reason || null, beforeTokens: context?.tokens ?? null,
        afterTokens: Number.isFinite(after?.tokens) ? after.tokens : null, account: await accountOf(name, pane).catch(() => null) });
      return result.ok ? { ok: true, compacted: true, receipt: result }
        : { ok: false, attempted: true, reason: `context-cost:${result.reason}`, detail: result.detail || null, ...(retryAt ? { retryAt } : {}) };
    } catch (error) {
      if (intent) write(state, paneKey(name, pane), { ...intent, status: submitted ? "FAILED" : "NOT_SENT", reason: error.message, finishedAt: now() });
      finishQuotaCompact(state, quotaClaim, submitted ? "unknown" : "not-sent", error.message, now());
      log(`${name}:${pane} context compact failed: ${error.message}`);
      return { ok: false, reason: `context-cost:${error.message}` };
    } finally { lease?.release(); }
  }
  // Mattias 2026-09-26: "ni orkestrerar ju. Jag kan ju inte få en fråga, då
  // kommer ju panelen låsa sig". A person's own message is delivered even when
  // the compact failed or the evidence is unreadable. skyvw:4 2026-10-13:
  // automatic work (a goal, recovery or follow-up prompt) waits instead, with
  // no second paid attempt, until evidence, a verified compact or new work arrives.
  async function beforeWork(job, { lease = null } = {}) {
    const { agentName, pane, id } = job;
    const self = job.source === QUOTA_WIND_DOWN_ORIGIN ? null : await selfBeforeWork({ agentName, pane, id }, lease);
    const result = self ?? await run(agentName, pane, { cold: true, leaseHeld: true, heldLease: lease, jobId: id });
    // The broker types the message next, which needs the session again.
    if (!await regainSessionLease(lease)) return { ok: false, reason: "delivery-lease-busy" };
    if (result.ok) return result;
    // A pane's own compact request is about growth, not a cold cache: it never holds work.
    const admission = self ? null : workAdmission({ ok: false, need: result.need, human: isOwnerChannelJob(job) });
    if (admission?.values.action === "HOLD") return { ok: false, held: true, cell: admission.cell, reason: `${admission.cell}:${result.reason}` };
    log(`${agentName}:${pane} delivered without compact (${admission?.cell || "self-compact"}): ${result.reason}`);
    return { ok: true, cell: "delivered-uncompacted", reason: result.reason };
  }
  // A pane that asked to be compacted at its stage boundary gets it before the next
  // prompt lands, under the same guards: no subagent or job still writing, 80k, 30 minutes.
  const noticeSelf = (request, ending) => Promise.resolve()
    .then(() => notify(request.agent, request.pane, formatSelfCompactNotice(`${request.agent}:${request.pane}`, { ...ending, focus: request.focus })))
    .catch((error) => log(`${request.agent}:${request.pane} self-compact notice failed: ${error.message}`));
  async function selfBeforeWork({ agentName, pane, id }, lease) {
    const request = selfRequests?.read(agentName, pane);
    if (!request) return null;
    const target = resolveTarget(agentName, pane);
    const identity = target && identityFor(target.engine, target.dir);
    // A park's compact is due before the stop, even while a subagent or job still works.
    const background = identity && ![QUOTA_PARK_ORIGIN, QUOTA_WIND_DOWN_ORIGIN].includes(request.origin) ? coldBeforeDelivery?.background({ engine: target.engine,
      sessionPath: identity.path, sessionId: identity.sessionId, paneDir: target.dir, now: now() }) : null;
    if (background) { log(`${agentName}:${pane} self-compact held before delivery: ${background}`); return null; }
    const context = await (agent.getContext?.(agentName, pane) ?? agent.getContextPercent(agentName, pane));
    const admission = selfCompactAdmission({ tokens: context?.tokens, lastCompactAt: lastContextCompactAt(state, agentName, pane), now: now() });
    if (!admission.ok) {
      selfRequests.clear(agentName, pane);
      noticeSelf(request, { outcome: "satisfied", detail: admission.detail });
      return null;
    }
    const result = await run(agentName, pane, { pauseTokens: SELF_COMPACT_POLICY.minTokens, pauseSettleMs: 0, beforeDelivery: true,
      focus: request.focus, leaseHeld: true, heldLease: lease, jobId: id });
    if (!result.compacted && !result.attempted) return null;
    // The waiting delivery already continues or replaces the task. Do not
    // enqueue the older handoff behind it.
    selfRequests.clear(agentName, pane);
    noticeSelf(request, result.compacted ? { outcome: "compacted", tokens: context?.tokens } : { outcome: "failed", detail: result.reason });
    return result;
  }
  return { canAttempt, run, beforeWork, selfRequestSuperseded, finishSelfRequest };
}
