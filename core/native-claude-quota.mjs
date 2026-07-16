// Native Claude quota evidence and retry scheduling.
//
// A native runtime still launches Claude Code. A pre-execution 429 is safe to
// retry with the same operation key; any turn that produced model text, tools,
// or usage remains terminally ambiguous and is never replayed automatically.

import {
  CLAUDE_LIMIT_TEXT,
  claudeQuotaRecoveryReadiness,
  parseClaudeLimitResetAt,
  quotaRecoveryContinuation,
} from "./claude-quota-recovery.mjs";

const ZERO_USAGE_FIELDS = [
  "input_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "output_tokens",
];

function singleAssistantText(event) {
  const blocks = Array.isArray(event?.message?.content) ? event.message.content : [];
  const texts = blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text.trim())
    .filter(Boolean);
  return texts.length === 1 ? texts[0] : null;
}

function zeroUsage(event) {
  const usage = event?.usage ?? {};
  return ZERO_USAGE_FIELDS.every((field) => Number(usage[field] ?? 0) === 0)
    && Object.values(event?.modelUsage ?? {}).every((model) =>
      ZERO_USAGE_FIELDS.every((field) => Number(model?.[field] ?? 0) === 0));
}

/**
 * WHAT: Parses Claude's exact synthetic quota assistant before a terminal result.
 * WHY: Keeps ordinary model prose from authorizing an automatic retry.
 */
export function nativeClaudeQuotaCandidate(event) {
  const text = singleAssistantText(event);
  const match = text && CLAUDE_LIMIT_TEXT.exec(text);
  if (event?.type !== "assistant"
      || event.error !== "rate_limit"
      || event.message?.model !== "<synthetic>"
      || !match
      || !event.session_id
      || !event.uuid) return null;
  const observedAt = Date.parse(event.timestamp);
  if (!Number.isFinite(observedAt)) return null;
  return {
    text,
    limitKind: match[1].toLowerCase(),
    sessionId: event.session_id,
    limitEventId: event.uuid,
    observedAt,
    resetAt: parseClaudeLimitResetAt(text, observedAt),
  };
}

/**
 * WHAT: Returns retry evidence only for a conclusively pre-execution native 429.
 * WHY: Keeps partial or ambiguous turns from being executed twice.
 */
export function nativeClaudeQuotaReceipt(event, {
  candidate,
  sessionId,
  hadAssistantText = false,
  hadToolActivity = false,
} = {}) {
  if (!candidate
      || event?.type !== "result"
      || event.is_error !== true
      || Number(event.api_error_status) !== 429
      || event.terminal_reason !== "api_error"
      || event.session_id !== candidate.sessionId
      || event.session_id !== sessionId
      || String(event.result || "").trim() !== candidate.text
      || Number(event.num_turns) !== 1
      || !zeroUsage(event)
      || hadAssistantText
      || hadToolActivity) return null;
  return Object.freeze({
    version: 1,
    engine: "claude",
    backend: "native",
    sessionId: candidate.sessionId,
    limitEventId: event.uuid || candidate.limitEventId,
    limitKind: candidate.limitKind,
    text: candidate.text,
    observedAt: candidate.observedAt,
    resetAt: candidate.resetAt,
  });
}

const sameReceipt = (left, right) => Boolean(left && right
  && left.sessionId === right.sessionId
  && left.limitEventId === right.limitEventId);

/**
 * WHAT: Schedules one coalesced quota check for every durably waiting operation.
 * WHY: Keeps repeated runtime polls from spawning duplicate recovery turns.
 */
export function createNativeClaudeQuotaRetryScheduler({
  readQuota,
  onReady,
  now = () => Date.now(),
  pollMs = 30_000,
  resetGraceMs = 15_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  log = () => {},
} = {}) {
  if (typeof readQuota !== "function" || typeof onReady !== "function") {
    throw new Error("native Claude quota scheduler requires readQuota and onReady");
  }
  const waiting = new Map();
  let quotaRead = null;
  let stopped = false;

  const readOnce = () => {
    if (!quotaRead) {
      quotaRead = Promise.resolve().then(readQuota)
        .catch((error) => ({ ok: false, engine: "claude", error: error.message }))
        .finally(() => { quotaRead = null; });
    }
    return quotaRead;
  };

  const arm = (key, receipt, { immediate = false } = {}) => {
    if (stopped || !key || !receipt) return false;
    const existing = waiting.get(key);
    if (existing && sameReceipt(existing.receipt, receipt)) return false;
    if (existing) clearTimer(existing.timer);
    const entry = { receipt, timer: null };
    entry.timer = setTimer(async () => {
      if (waiting.get(key) !== entry || stopped) return;
      waiting.delete(key);
      const quota = await readOnce();
      const readiness = claudeQuotaRecoveryReadiness(receipt, quota, {
        now: now(),
        resetGraceMs,
      });
      if (readiness.ready) {
        try { await onReady(key, receipt, readiness); }
        catch (error) {
          log(`native Claude quota recovery ${key} failed: ${error.message}`);
          arm(key, receipt);
        }
      } else {
        arm(key, receipt);
      }
    }, immediate ? 0 : pollMs);
    entry.timer.unref?.();
    waiting.set(key, entry);
    return true;
  };

  return {
    arm,
    cancel(key) {
      const entry = waiting.get(key);
      if (!entry) return false;
      clearTimer(entry.timer);
      waiting.delete(key);
      return true;
    },
    stop() {
      stopped = true;
      for (const entry of waiting.values()) clearTimer(entry.timer);
      waiting.clear();
    },
    size: () => waiting.size,
  };
}

/**
 * WHAT: Routes native turn evidence through durable quota recovery.
 * WHY: Keeps retry policy out of the capped transport server and bound to one seam.
 */
export function createNativeClaudeQuotaController({
  queuedMessages,
  agents,
  readQuota,
  save,
  webEvent,
  fleetEvent,
  drain,
  now = () => Date.now(),
  pollMs = 30_000,
  log = () => {},
} = {}) {
  const scheduler = createNativeClaudeQuotaRetryScheduler({
    readQuota,
    pollMs,
    log,
    onReady: (operationKey, receipt, readiness) => {
      const entry = queuedMessages.get(operationKey);
      if (!entry?.quotaWait || !sameReceipt(entry.quotaWait, receipt)) return;
      delete entry.quotaWait;
      entry.quotaRecoveredAt = now();
      const agent = agents.get(entry.id);
      save();
      if (!agent) return;
      webEvent(agent, "quota-recovered", { backend: "native", operationKey, via: readiness.via });
      fleetEvent(agent, "notification", { detail: "native Claude quota recovered; retrying same operation" });
      drain(agent);
    },
  });

  return {
    resetTurn(agent) {
      agent.turnHadToolActivity = false;
      agent.turnQuotaCandidate = null;
      agent.turnQuotaWait = null;
    },
    markTool(agent) { agent.turnHadToolActivity = true; },
    observe(agent, event) {
      if (agent.operation !== "turn" || agent.interruptRequested) return null;
      const candidate = nativeClaudeQuotaCandidate(event);
      if (candidate) {
        agent.turnQuotaCandidate = candidate;
        return { handled: true, endInput: false };
      }
      const receipt = nativeClaudeQuotaReceipt(event, {
        candidate: agent.turnQuotaCandidate,
        sessionId: agent.sessionId,
        hadAssistantText: agent.turnHasAssistantText,
        hadToolActivity: agent.turnHadToolActivity,
      });
      if (!receipt) return null;
      agent.turnQuotaWait = receipt;
      return { handled: true, endInput: true };
    },
    take(agent, operationKey) {
      return operationKey && queuedMessages.has(operationKey) ? agent.turnQuotaWait : null;
    },
    clearTurn(agent) {
      agent.turnQuotaCandidate = null;
      agent.turnQuotaWait = null;
    },
    park(agent, operationKey, receipt, quotaWait) {
      const entry = queuedMessages.get(operationKey);
      delete entry.startedAt;
      Object.assign(entry, { quotaWait, quotaAttempts: Number(entry.quotaAttempts || 0) + 1 });
      Object.assign(receipt, { sessionId: agent.sessionId, quotaWait });
    },
    wait(agent, operationKey, quotaWait) {
      webEvent(agent, "quota-waiting", {
        backend: "native", operationKey, resetAt: quotaWait.resetAt,
        limitEventId: quotaWait.limitEventId,
      });
      scheduler.arm(operationKey, quotaWait);
    },
    blocks(operationKey, entry) {
      if (!entry.quotaWait) return false;
      scheduler.arm(operationKey, entry.quotaWait);
      return true;
    },
    attempt(entry) {
      return entry.quotaRecoveredAt
        ? { prompt: quotaRecoveryContinuation(), attachments: [], retry: true }
        : { prompt: entry.prompt, attachments: entry.attachments, retry: false };
    },
    stop: () => scheduler.stop(),
  };
}
