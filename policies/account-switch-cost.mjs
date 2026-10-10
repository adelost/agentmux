import { choice, decide, defineDecisionTable, on } from "@v1d/product-spec";
import { CONTEXT_COST_POLICY } from "./context-cost.mjs";

// Mattias 2026-10-10: "det kostar pengar att byta subscription.. blir en cache
// miss" and "tänk dock på att inte byta i onödan.. pga cache miss". The prompt
// cache belongs to one account, so a pane that moves re-reads its whole
// context on the target. Only a warm, large context is worth a compact on the
// source first; the 80k and one-hour limits are the ones context-cost.mjs
// documents for every other compact decision.
//
// A cold cache is re-read in full whichever account the next prompt goes to,
// so moving a cold pane costs nothing extra. A dormant pane only gets its new
// selection for its next ordinary wake. A source that can no longer answer
// (usage limit, access disabled) cannot compact; restarting there is the only
// way back to work, and the plan says so instead of blocking the pane forever.

/** WHAT: Names the decision table for one pane's account switch. WHY: Keeps every switch path inspectable before any process or model change. */
export const accountSwitchCostRules = defineDecisionTable({
  id: "amux.account-switch-cost",
  axes: {
    process: ["DORMANT", "RUNNING", "RECOVERING"],
    selected: ["TARGET", "OTHER"],
    evidence: ["KNOWN", "UNKNOWN"],
    cache: ["WARM", "COLD"],
    size: ["SMALL", "LARGE"],
    source: ["OPEN", "LIMITED"],
    compact: ["ADMISSIBLE", "REFUSED"],
  },
  columns: { action: choice(["KEEP", "SELECT", "RESTART", "COMPACT_THEN_RESTART", "HOLD"]) },
  cells: [
    on("interrupted-switch", { process: "RECOVERING" }, { action: "RESTART" }),
    on("already-selected", { process: ["DORMANT", "RUNNING"], selected: "TARGET" }, { action: "KEEP" }),
    on("dormant", { process: "DORMANT", selected: "OTHER" }, { action: "SELECT" }),
    on("context-unknown", { process: "RUNNING", selected: "OTHER", evidence: "UNKNOWN" }, { action: "HOLD" }),
    on("cache-cold", { process: "RUNNING", selected: "OTHER", evidence: "KNOWN", cache: "COLD" }, { action: "RESTART" }),
    on("context-small", { process: "RUNNING", selected: "OTHER", evidence: "KNOWN", cache: "WARM", size: "SMALL" },
      { action: "RESTART" }),
    on("source-limited", { process: "RUNNING", selected: "OTHER", evidence: "KNOWN", cache: "WARM", size: "LARGE",
      source: "LIMITED" }, { action: "RESTART" }),
    on("compact-refused", { process: "RUNNING", selected: "OTHER", evidence: "KNOWN", cache: "WARM", size: "LARGE",
      source: "OPEN", compact: "REFUSED" }, { action: "HOLD" }),
    on("compact-first", { process: "RUNNING", selected: "OTHER", evidence: "KNOWN", cache: "WARM", size: "LARGE",
      source: "OPEN", compact: "ADMISSIBLE" }, { action: "COMPACT_THEN_RESTART" }),
  ],
  invariants: [
    { refuse: "a warm large context on an answering source never moves without compact",
      when: d => d.at.process === "RUNNING" && d.at.selected === "OTHER" && d.at.evidence === "KNOWN"
        && d.at.cache === "WARM" && d.at.size === "LARGE" && d.at.source === "OPEN" && d.values.action === "RESTART" },
    { refuse: "unknown context evidence never authorizes a restart or compact",
      when: d => d.at.process === "RUNNING" && d.at.selected === "OTHER" && d.at.evidence === "UNKNOWN"
        && d.values.action !== "HOLD" },
    { refuse: "a dormant pane is never woken, restarted or compacted",
      when: d => d.at.process === "DORMANT" && !["SELECT", "KEEP"].includes(d.values.action) },
  ],
});

const SOURCE_LIMITS = new Set(["provider-usage-limited", "claude-subscription-access-disabled"]);

/**
 * WHAT: Maps one pane's observed facts to its switch action and the cell that chose it.
 * WHY: Keeps token, idle and source limits outside the restart code and unknown facts out of permissive defaults.
 */
export function accountSwitchPlan({ mode, alreadySelected = false, facts = null, compactRefusal = null, compacted = false },
  policy = CONTEXT_COST_POLICY) {
  const process = mode === "dormant" ? "DORMANT" : mode === "recovering" ? "RECOVERING" : "RUNNING";
  const tokens = Number.isFinite(facts?.tokens) ? facts.tokens : null;
  const idleMs = Number.isFinite(facts?.idleMs) ? facts.idleMs : null;
  // A verified compact receipt proves the context was summarized even when its size is not measured yet.
  const small = compacted || (tokens !== null && tokens <= policy.maxTokens);
  const known = idleMs !== null && (tokens !== null || compacted);
  const decision = decide(accountSwitchCostRules, {
    process,
    selected: alreadySelected ? "TARGET" : "OTHER",
    evidence: known ? "KNOWN" : "UNKNOWN",
    cache: idleMs !== null && idleMs >= policy.coldMs ? "COLD" : "WARM",
    size: small ? "SMALL" : "LARGE",
    source: SOURCE_LIMITS.has(facts?.blocker) ? "LIMITED" : "OPEN",
    compact: compactRefusal ? "REFUSED" : "ADMISSIBLE",
  });
  const detail = decision.cell === "source-limited" ? `source-limited:${facts.blocker}`
    : decision.cell === "compact-refused" ? `compact-refused:${compactRefusal}`
      : decision.cell;
  return { action: decision.values.action, cell: decision.cell, reason: detail, tokens, idleMs };
}
