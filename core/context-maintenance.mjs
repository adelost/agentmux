import { contextCostDecision, readContextCostPolicy } from "../policies/context-cost.mjs";
import { latestConversationActivityMs } from "./pane-activity.mjs";
import { latestPaneSessionIdentity } from "./native-session-identity.mjs";
import { captureJsonlAppendCursor, hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { verifiedClaudeCompact, verifiedCodexCompact } from "./verified-compact.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { prepareCodexIdle } from "./codex-tui.mjs";
import { getContextPercent } from "./context.mjs";

const STATE_KEY = "context_maintenance_by_pane_v1";
const paneKey = (name, pane) => `${name}:${pane}`;
const compactEvent = e => e?.type === "compacted" || e?.payload?.type === "context_compacted"
  || (e?.type === "system" && e.subtype === "compact_boundary");
const workEvent = e => e?.type === "event_msg" && e.payload?.type === "user_message"
  || (e?.type === "user" && !e.isMeta && !e.isCompactSummary
    && (typeof e.message?.content === "string" ? !/^\s*<(?:local-command|command-)/u.test(e.message.content)
      : e.message?.content?.some(part => part.type === "text")));

function write(state, key, record) {
  state.set(STATE_KEY, { ...state.get(STATE_KEY, {}), [key]: record });
}

/** WHAT: Stores verified compact evidence from another maintenance path. WHY: Prevents model switching and cold-wake protection from compacting the same context twice. */
export function rememberContextCompact(state, name, pane, receipt) {
  if (!state || !receipt?.ok) return;
  write(state, paneKey(name, pane), { sessionId: receipt.sessionId, cursor: receipt.cursor, status: "VERIFIED" });
}

/** WHAT: Reads the current context-generation fence. WHY: Keeps warm, cold and nightly maintenance from repeating a paid attempt without new work. */
export function contextMaintenanceAttempt(state, name, pane, identity = null) {
  const record = state?.get?.(STATE_KEY, {})?.[paneKey(name, pane)];
  if (!record || record.status === "NOT_SENT" || (identity && record.sessionId !== identity.sessionId)) return null;
  const files = Object.keys(record.cursor?.positions || {});
  if (!files.length || hasJsonlEventAfterCursor(files, record.cursor, workEvent)) return null;
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

  async function run(name, pane, { cold = false, leaseHeld = false, jobId = null } = {}) {
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
    const safe = !await agent.isBusy(name, pane)
      && (await agent.promptTransportState(name, pane, "").catch(() => null))?.state === "empty-idle";
    const decision = contextCostDecision({ tokens: context?.tokens, idleMs: Number.isFinite(activity) ? now() - activity : NaN, cold, safe, attempt }, policy);
    if (decision.values.action === "CONTINUE") return { ok: true, cell: decision.cell };
    if (decision.values.action === "HOLD") return { ok: false, reason: `context-cost:${decision.cell}${prior?.reason ? `:${prior.reason}` : ""}` };
    const lease = leaseHeld ? null : queue.acquireSessionLease(name);
    if (!leaseHeld && !lease) return { ok: false, reason: "delivery-lease-busy" };
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
        latestIdentity: dir => identityFor(target.engine, dir), maxRescues: 0 });
      write(state, paneKey(name, pane), { ...record, status: result.ok ? "VERIFIED" : "FAILED", reason: result.reason || null });
      log(`${name}:${pane} ${decision.cell}: ${result.ok ? "compact verified" : result.reason}`);
      return result.ok ? { ok: true, compacted: true, receipt: result } : { ok: false, reason: `context-cost:${result.reason}` };
    } catch (error) {
      if (intent && !submitted) write(state, paneKey(name, pane), { ...intent, status: "NOT_SENT", reason: error.message });
      log(`${name}:${pane} context compact failed: ${error.message}`);
      return { ok: false, reason: `context-cost:${error.message}` };
    } finally { lease?.release(); }
  }
  return { canAttempt, run, beforeWork: ({ agentName, pane, id }) => run(agentName, pane, { cold: true, leaseHeld: true, jobId: id }) };
}
