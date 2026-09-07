// Nightly token-budget policy, separate from the bridge's percentage warning.

/** WHAT: Checks the nightly budget. WHY: Keeps byte sizes and percentages outside token admission. */
export function nightlyCompactPolicy(value) {
  if (value === false) return { enabled: false, maxTokens: 80_000, idleMinutes: 30 };
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("dream.compact must be false or an object");
  }
  const policy = { enabled: true, maxTokens: 80_000, idleMinutes: 30, ...value };
  if (Object.keys(policy).some((key) => !["enabled", "maxTokens", "idleMinutes"].includes(key))
      || typeof policy.enabled !== "boolean"
      || !Number.isSafeInteger(policy.maxTokens) || policy.maxTokens < 1
      || !Number.isSafeInteger(policy.idleMinutes) || policy.idleMinutes < 1) {
    throw new Error("dream.compact requires enabled:boolean, maxTokens:positive integer, idleMinutes:positive integer");
  }
  return policy;
}

/** WHAT: Checks idle contexts by tokens. WHY: Prevents a large million-token pane escaping through a low percentage. */
export function nightlyCompactDecision(facts, policy, previous = null) {
  if (!policy.enabled) return "disabled";
  if (!["claude", "codex"].includes(facts.engine)) return "compact-receipt-unsupported";
  if (facts.backend !== "tmux" || facts.running !== true) return "not-running-tmux";
  if (!facts.sessionId || !facts.sessionPath) return "exact-session-unknown";
  if (previous?.sessionId === facts.sessionId) return `already-attempted:${previous.status}`;
  if (facts.blocker) return facts.blocker;
  if (facts.status !== "idle") return `not-idle:${facts.status || "unknown"}`;
  if (!facts.composerEmpty) return "composer-not-empty";
  if (facts.queued !== 0) return "delivery-pending-or-unknown";
  if (!facts.model || !facts.effort || /haiku/iu.test(facts.model) || /^low$/iu.test(facts.effort)) {
    return "compact-quality-unverified-or-blocked";
  }
  if (!Number.isFinite(facts.tokens) || facts.tokens < 0) return "context-tokens-unknown";
  if (facts.tokens <= policy.maxTokens) return "within-budget";
  if (!Number.isFinite(facts.idleMs)) return "activity-unknown";
  if (facts.idleMs < policy.idleMinutes * 60_000) return "recent-activity";
  return null;
}

/** WHAT: Describes the verified result without retrying it. WHY: Prevents slash acknowledgement or unknown usage from becoming a budget-success claim. */
export function nightlyCompactOutcome(receipt, before, after, maxTokens) {
  if (!receipt?.ok || !receipt.compactBoundary) return { status: "failed", reason: receipt?.reason || "compact-unverified" };
  if (receipt.sessionId !== before.sessionId || after.sessionId !== before.sessionId
      || after.sessionPath !== before.sessionPath) return { status: "failed", reason: "compact-session-changed" };
  if (!Number.isFinite(after.tokens)) return { status: "compacted-unmeasured", afterTokens: null };
  return {
    status: after.tokens <= maxTokens ? "within-budget" : "compacted-above-budget",
    afterTokens: after.tokens,
  };
}

/** WHAT: Reads explicit compact refusal text. WHY: Keeps a provider access stop separate from a missing receipt. */
export function compactAccessBlocker(screen) {
  const lines = String(screen || "").split("\n");
  const lastTurn = lines.findLastIndex((line) => /^\s*[❯›]\s*\S/u.test(line));
  const text = lines.slice(Math.max(0, lastTurn)).join("\n");
  if (/organization has disabled Claude subscription access/iu.test(text)) return "claude-subscription-access-disabled";
  if (/you(?:'|’)?ve hit your (?:session|usage) limit|usage limit reached|out of extra usage/iu.test(text)) return "provider-usage-limited";
  return null;
}
