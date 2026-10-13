import { contextCostDecision, readContextCostPolicy, workAdmission } from "../policies/context-cost.mjs";
import { ownerMessageWaiting } from "./ask-origin.mjs";
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

const STATE_KEY = "context_maintenance_by_pane_v1";
const paneKey = (name, pane) => `${name}:${pane}`;
const compactEvent = e => e?.type === "compacted" || e?.payload?.type === "context_compacted"
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
export function contextMaintenanceAttempt(state, name, pane, identity = null) {
  const record = state?.get?.(STATE_KEY, {})?.[paneKey(name, pane)];
  if (!record || record.status === "NOT_SENT" || (identity && record.sessionId !== identity.sessionId)) return null;
  const files = Object.keys(record.cursor?.positions || {});
  if (!files.length || hasWorkAfter(files, record.cursor)) return null;
  if (record.status !== "VERIFIED" && hasJsonlEventAfterCursor(files, record.cursor, compactEvent)) {
    const verified = { ...record, status: "VERIFIED" };
    write(state, paneKey(name, pane), verified);
    return verified;
  }
  return record;
}

/** WHAT: Stores a maintenance intent before the model call. WHY: Prevents a crash or an ambiguous compact from becoming permission to spend again. */
export function beginContextCompact(state, name, pane, identity) {
  if (!state) return;
  const cursor = captureJsonlAppendCursor("context-maintenance-v1", [identity.path]);
  write(state, paneKey(name, pane), { sessionId: identity.sessionId, cursor, status: "ATTEMPTING", at: Date.now() });
}

/** WHAT: Builds shared warm and cold context protection. WHY: Keeps paid compact attempts durable, serialized and bound to exact session evidence. */
export function createContextMaintenance({ agent, state, queue, resolveTarget, now = Date.now, log = () => {}, policy = readContextCostPolicy(),
  identityFor = latestPaneSessionIdentity, activityFor = latestConversationActivityMs, journalFor = getContextPercent,
  compactFor = engine => engine === "codex" ? verifiedCodexCompact : verifiedClaudeCompact, coldBeforeDelivery = null,
  selfRequests = null, notify = async () => {} }) {
  const existing = (name, pane, identity) => contextMaintenanceAttempt(state, name, pane, identity);

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
    jobId = null, focus = "", beforeDelivery = cold } = {}) {
    const target = resolveTarget(name, pane);
    if (!target || !["claude", "codex"].includes(target.engine)) return { ok: true, skipped: "unsupported-engine" };
    if (typeof agent.paneProcessState !== "function" || (await agent.paneProcessState(name, pane).catch(() => null))?.running !== true) {
      return { ok: !cold, skipped: "not-running", reason: "context-cost:not-running" };
    }
    const identity = identityFor(target.engine, target.dir);
    if (!identity) return { ok: true, skipped: "no-session" };
    const prior = existing(name, pane, identity);
    if (prior?.status === "VERIFIED") return { ok: true, cell: "receipt-exists" };
    const context = await (agent.getContext?.(name, pane) ?? agent.getContextPercent(name, pane));
    let activity = activityFor(target.dir, target.engine, { recoverCodexHistory: true });
    if (!Number.isFinite(activity)) {
      const usage = journalFor(target.dir, target.engine, { journalOnly: true });
      activity = usage?.source?.endsWith("-jsonl") ? Date.parse(usage.observedAt) : NaN;
    }
    const attempt = prior ? (prior.status === "VERIFIED" ? "VERIFIED" : "FAILED") : "NEW";
    // Names what holds the pane, e.g. "pasting" for a composer held by Claude's clipboard lookup.
    const input = await agent.isBusy(name, pane) ? "busy"
      : (await agent.promptTransportState(name, pane, "").catch(() => null))?.state || "unreadable";
    const safe = input === "empty-idle";
    const facts = { tokens: context?.tokens, idleMs: Number.isFinite(activity) ? now() - activity : NaN, cold, pauseTokens,
      ...(pauseSettleMs != null ? { pauseSettleMs } : {}), safe, attempt };
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
    const result = await compactOnce({ name, pane, target, identity, context, decision, dry, leaseHeld, heldLease, jobId, focus, beforeDelivery });
    return result.ok ? result : { ...result, need };
  }

  // Sends one compact under the session lease, with its intent stored before the paid call.
  async function compactOnce({ name, pane, target, identity, context, decision, dry, leaseHeld, heldLease, jobId, focus, beforeDelivery }) {
    const lease = leaseHeld ? null : queue.acquireSessionLease(name, pane);
    if (!leaseHeld && !lease) return { ok: false, reason: "delivery-lease-busy" };
    // Once the command is sent only this pane stays fenced, so its siblings
    // are served during a compact that can take minutes.
    const writer = lease ?? heldLease;
    const pending = () => queue.list(name, pane).some(j => j.id !== jobId && !TERMINAL_DELIVERY_STATES.has(j.status) && (!beforeDelivery || j.status !== "pending"));
    let submitted = false, intent = null;
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
      if (dry) return { ok: true, dry: true, cell: decision.cell, tokens: context.tokens };
      if (target.engine === "codex") {
        const idle = await prepareCodexIdle({ agent, name, pane });
        if (!idle.ok) return { ok: false, reason: `context-cost:${idle.stage}:${idle.error}` };
      }
      const cursor = captureJsonlAppendCursor("context-maintenance-v1", [identity.path]);
      const record = { sessionId: identity.sessionId, cursor, status: "ATTEMPTING", at: now(), cell: decision.cell, beforeTokens: context.tokens };
      intent = record;
      write(state, paneKey(name, pane), record);
      const compact = compactFor(target.engine);
      const guardedAgent = { ...agent, sendOnly: async (agentName, text, index, options) => {
        const guard = async stage => {
          const latest = identityFor(target.engine, target.dir);
          const input = await agent.promptTransportState(name, pane, stage === "submit" ? text : "");
          if (latest?.sessionId !== identity.sessionId || pending() || await agent.isBusy(name, pane)
              || input?.state !== (stage === "submit" ? "drafted" : "empty-idle")) throw new Error("context-cost:pre-submit-state-changed");
        };
        await guard("paste");
        return agent.sendOnly(agentName, text, index, { ...options, existingOnly: true, maintenanceGuard: guard,
          onSubmitting: async () => { submitted = true; await options?.onSubmitting?.(); } });
      } };
      const result = await compact({ agent: guardedAgent, agentName: name, pane, paneDir: target.dir,
        latestIdentity: dir => identityFor(target.engine, dir), maxRescues: 0,
        ...(focus && target.engine === "claude" ? { command: `/compact ${focus}` } : {}),
        onCommandAccepted: () => writer?.releaseSession?.() });
      write(state, paneKey(name, pane), { ...record, status: result.ok ? "VERIFIED" : "FAILED", reason: result.reason || null });
      log(`${name}:${pane} ${decision.cell}: ${result.ok ? "compact verified" : result.reason}`);
      return result.ok ? { ok: true, compacted: true, receipt: result }
        : { ok: false, attempted: true, reason: `context-cost:${result.reason}`, detail: result.detail || null };
    } catch (error) {
      if (intent && !submitted) write(state, paneKey(name, pane), { ...intent, status: "NOT_SENT", reason: error.message });
      log(`${name}:${pane} context compact failed: ${error.message}`);
      return { ok: false, reason: `context-cost:${error.message}` };
    } finally { lease?.release(); }
  }
  // Mattias 2026-09-26: "ni orkestrerar ju. Jag kan ju inte få en fråga, då
  // kommer ju panelen låsa sig". Unknown evidence never holds work (518
  // deliveries once waited on it), and a person's own message is delivered
  // even when the compact failed. skyvw:4 2026-10-13: automatic work (a goal,
  // recovery or follow-up prompt) on a cold large context waits instead, with
  // no second paid attempt, until the compact verifies or new work arrives.
  async function beforeWork(job, { lease = null } = {}) {
    const { agentName, pane, id } = job;
    const self = await selfBeforeWork({ agentName, pane, id }, lease);
    const result = self ?? await run(agentName, pane, { cold: true, leaseHeld: true, heldLease: lease, jobId: id });
    // The broker types the message next, which needs the session again.
    if (!await regainSessionLease(lease)) return { ok: false, reason: "delivery-lease-busy" };
    if (result.ok) return result;
    // A pane's own compact request is about growth, not a cold cache: it never holds work.
    // The FIFO delivers in order, so an owner's message behind this job releases it too:
    // that message pays the cold read anyway.
    const admission = workAdmission({ ok: false, need: self ? null : result.need, human: ownerMessageWaiting(queue, job) });
    if (admission.values.action === "HOLD") return { ok: false, cell: admission.cell, reason: `${admission.cell}:${result.reason}` };
    log(`${agentName}:${pane} delivered without compact (${admission.cell}): ${result.reason}`);
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
    const background = identity ? coldBeforeDelivery?.background({ engine: target.engine, sessionPath: identity.path,
      sessionId: identity.sessionId, paneDir: target.dir, now: now() }) : null;
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
