// Nightly token budget; the quiet-time default is shared with daytime maintenance.

import { CONTEXT_COST_POLICY } from "../policies/context-cost.mjs";
import { CLAUDE_STOP_BANNER } from "./claude-quota-recovery.mjs";

/** WHAT: Checks the nightly budget. WHY: Keeps byte sizes and percentages outside token admission. */
export function nightlyCompactPolicy(value) {
  if (value === false) return { enabled: false, maxTokens: CONTEXT_COST_POLICY.coldMaxTokens, idleMinutes: CONTEXT_COST_POLICY.idleMs / 60_000 };
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("dream.compact must be false or an object");
  }
  const policy = { enabled: true, maxTokens: CONTEXT_COST_POLICY.coldMaxTokens, idleMinutes: CONTEXT_COST_POLICY.idleMs / 60_000, ...value };
  if (Object.keys(policy).some((key) => !["enabled", "maxTokens", "idleMinutes"].includes(key))
      || typeof policy.enabled !== "boolean"
      || !Number.isSafeInteger(policy.maxTokens) || policy.maxTokens < 1
      || !Number.isSafeInteger(policy.idleMinutes) || policy.idleMinutes < 1) {
    throw new Error("dream.compact requires enabled:boolean, maxTokens:positive integer, idleMinutes:positive integer");
  }
  return policy;
}

/** WHAT: Checks idle contexts by tokens. WHY: Prevents a large million-token pane escaping through a low percentage. */
export function nightlyCompactDecision(facts, policy, previous = null, { force = false, retryUnmeasured = false, retryStale = false } = {}) {
  if (!policy.enabled) return "disabled";
  if (!["claude", "codex"].includes(facts.engine)) return "compact-receipt-unsupported";
  if (facts.backend !== "tmux" || facts.running !== true) return "not-running-tmux";
  if (!facts.sessionId || !facts.sessionPath) return "exact-session-unknown";
  if (previous?.sessionId === facts.sessionId && !(retryUnmeasured && isUnmeasuredCompact(previous, facts))
      && !(retryStale && previous.sessionPath === facts.sessionPath && previous.status === "failed"
        && previous.reason === "stale-attempt-above-budget" && !previous.staleRetryUsed)) {
    return `already-attempted:${previous.status}`;
  }
  if (facts.blocker) return facts.blocker;
  if (facts.status !== "idle") return `not-idle:${facts.status || "unknown"}`;
  if (!facts.composerEmpty) return "composer-not-empty";
  if (facts.queued !== 0) return "delivery-pending-or-unknown";
  if (!facts.model || !facts.effort || /haiku/iu.test(facts.model) || /^low$/iu.test(facts.effort)) {
    return "compact-quality-unverified-or-blocked";
  }
  if (!Number.isFinite(facts.tokens) || facts.tokens < 0) return "context-tokens-unknown";
  if (!force && facts.tokens <= policy.maxTokens) return "within-budget";
  if (!Number.isFinite(facts.idleMs)) return "activity-unknown";
  if (facts.idleMs < policy.idleMinutes * 60_000) return "recent-activity";
  return null;
}

/** WHAT: Resolves an abandoned account-switch intent from a fresh exact-session measurement. WHY: Prevents an interrupted writer from holding a pane for the rest of the day. */
export function resolveStaleCompact(record, facts, policy, now) {
  const at = Date.parse(record?.attemptedAt);
  const pending = record?.status === "attempting" || ["unverified", "measured"].includes(record?.status)
    && ["stale-attempt-timeout", "compact-attempt-timeout", "compact-attempt-measured"].includes(record.reason);
  if (!pending || record.sessionId !== facts.sessionId
      || record.sessionPath !== facts.sessionPath || !Number.isFinite(at) || now - at < 40 * 60_000
      || facts.engine !== "claude" || facts.backend !== "tmux" || facts.running !== true || facts.blocker
      || facts.status !== "idle" || !facts.composerEmpty || facts.queued !== 0) return null;
  if (!Number.isFinite(facts.tokens) || facts.tokens < 0 || !Number.isFinite(Date.parse(facts.tokensObservedAt))
      || Date.parse(facts.tokensObservedAt) < at) return { ...record, status: "unverified", reason: "stale-attempt-timeout",
    afterTokens: null, resolvedAt: new Date(now).toISOString() };
  return { ...record, status: facts.tokens <= policy.maxTokens ? "within-budget" : "failed",
    reason: facts.tokens <= policy.maxTokens ? "stale-attempt-measured" : "stale-attempt-above-budget",
    afterTokens: facts.tokens, resolvedAt: new Date(now).toISOString() };
}

/** WHAT: Checks an exact session's completed but unmeasured compact. WHY: Separates missing size proof from failed or still-running model calls. */
export function isUnmeasuredCompact(record, facts) {
  return record?.status === "compacted-unmeasured" && !record.staleRetryUsed && record.sessionId === facts.sessionId
    && record.sessionPath === facts.sessionPath;
}

/** WHAT: Describes the verified result without retrying it. WHY: Prevents slash acknowledgement or unknown usage from becoming a budget-success claim. */
export function nightlyCompactOutcome(receipt, before, after, maxTokens) {
  if (receipt?.nothingToCompact === true && receipt.sessionId === before.sessionId && after.sessionId === before.sessionId) {
    return { status: "nothing-to-compact", afterTokens: Number.isFinite(after.tokens) ? after.tokens : null };
  }
  if (!receipt?.ok || !receipt.compactBoundary) return { status: "failed", reason: receipt?.reason || "compact-unverified" };
  if (receipt.sessionId !== before.sessionId || after.sessionId !== before.sessionId
      || after.sessionPath !== before.sessionPath) return { status: "failed", reason: "compact-session-changed" };
  if (!Number.isFinite(after.tokens)) return { status: "compacted-unmeasured", afterTokens: null };
  return {
    status: after.tokens <= maxTokens ? "within-budget" : "compacted-above-budget",
    afterTokens: after.tokens,
  };
}

const UNRESOLVED_SKIP = /^(claude-subscription-access-disabled|claude-login-required|provider-usage-limited|activity-unknown|already-attempted:(failed|attempting|unverified|unknown|measured|compacted-))/u;

/** WHAT: Calculates how many rows leave tonight's budget work undone. WHY: Keeps one definition behind the report, the exit code and Dream's maintenance state. */
export function nightlyUnresolvedCount(rows, policy) {
  return rows.filter((row) => ["failed", "unverified"].includes(row.status) || row.status.startsWith("compacted-")
    || (row.beforeTokens > policy.maxTokens && UNRESOLVED_SKIP.test(row.reason || ""))).length;
}

/** WHAT: Reports a shared maintenance attempt without authorizing another call. WHY: Keeps failed or ambiguous work visible separately from retry prevention. */
export function sharedNightlyCompactOutcome(record, facts) {
  if (!record) return null;
  const base = { sessionId: record.sessionId, sharedStatus: record.status,
    beforeTokens: record.beforeTokens ?? facts.tokens, afterTokens: facts.tokens ?? null };
  // Another pass already compacted this context and nothing happened since, so
  // tonight attempted nothing and may not retry. Its size stays visible but
  // cannot fail the night: a size Claude has not journaled yet is unknown, and
  // re-reporting it would fail every night until the pane works again.
  if (record.status === "VERIFIED") {
    return { ...base, status: "already-compacted", reason: "compact-already-verified-without-new-work" };
  }
  return { ...base, status: record.status === "FAILED" ? "failed" : "unverified",
    reason: record.reason || (record.status === "FAILED" ? "previous-compact-failed" : "previous-compact-outcome-unknown") };
}

/** WHAT: Reads explicit compact refusal text. WHY: Keeps a provider access stop separate from a missing receipt. */
export function compactAccessBlocker(screen) {
  const lines = String(screen || "").split("\n");
  const lastTurn = lines.findLastIndex((line) => /^\s*[❯›]\s*\S/u.test(line));
  const text = lines.slice(Math.max(0, lastTurn)).join("\n");
  if (/(?:Login expired|Not logged in)\s*·\s*Please run \/login\b/iu.test(text)) return "claude-login-required";
  if (/organization has disabled Claude subscription access/iu.test(text)) return "claude-subscription-access-disabled";
  if (CLAUDE_STOP_BANNER.test(text) || /usage limit reached|out of extra usage/iu.test(text)) return "provider-usage-limited";
  return null;
}
