import { contextCostDecision, readContextCostPolicy } from "../policies/context-cost.mjs";
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
  write(state, paneKey(name, pane), { sessionId: receipt.sessionId, cursor: receipt.cursor, status: "VERIFIED" });
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
  compactFor = engine => engine === "codex" ? verifiedCodexCompact : verifiedClaudeCompact }) {
  const existing = (name, pane, identity) => contextMaintenanceAttempt(state, name, pane, identity);
  const canAttempt = (name, pane, sessionId) => !existing(name, pane, sessionId ? { sessionId } : null);

  async function run(name, pane, { cold = false, leaseHeld = false, heldLease = null, jobId = null } = {}) {
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
    const decision = contextCostDecision({ tokens: context?.tokens, idleMs: Number.isFinite(activity) ? now() - activity : NaN, cold, safe, attempt }, policy);
    if (decision.values.action === "CONTINUE") return { ok: true, cell: decision.cell };
    if (cold && target.engine === "claude" && decision.cell === "unknown-evidence" && attempt === "NEW"
        && safe && !Number.isFinite(context?.tokens)
        && await hasEmptyClaudeEpoch(identity)) {
      const current = identityFor(target.engine, target.dir);
      const transport = await agent.promptTransportState(name, pane, "").catch(() => null);
      if (current?.sessionId === identity.sessionId && current.path === identity.path
          && !await agent.isBusy(name, pane) && transport?.state === "empty-idle") {
        return { ok: true, cell: "empty-after-compact" };
      }
    }
    const holder = decision.cell === "not-idle" ? `:${input}` : "";
    if (decision.values.action === "HOLD") return { ok: false, reason: `context-cost:${decision.cell}${holder}${prior?.reason ? `:${prior.reason}` : ""}` };
    const lease = leaseHeld ? null : queue.acquireSessionLease(name, pane);
    if (!leaseHeld && !lease) return { ok: false, reason: "delivery-lease-busy" };
    // Once the command is sent only this pane stays fenced, so its siblings
    // are served during a compact that can take minutes.
    const writer = lease ?? heldLease;
    const pending = () => queue.list(name, pane).some(j => j.id !== jobId && !TERMINAL_DELIVERY_STATES.has(j.status) && (!cold || j.status !== "pending"));
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
  // kommer ju panelen låsa sig". Compact before work is best effort: when it
  // cannot run (unknown evidence, a failed attempt), the work is delivered
  // anyway. 518 deliveries were held on context-cost:unknown-evidence before.
  async function beforeWork({ agentName, pane, id }, { lease = null } = {}) {
    const result = await run(agentName, pane, { cold: true, leaseHeld: true, heldLease: lease, jobId: id });
    // The broker types the message next, which needs the session again.
    if (!await regainSessionLease(lease)) return { ok: false, reason: "delivery-lease-busy" };
    if (result.ok) return result;
    log(`${agentName}:${pane} delivered without compact: ${result.reason}`);
    return { ok: true, cell: "delivered-uncompacted", reason: result.reason };
  }
  return { canAttempt, run, beforeWork };
}
