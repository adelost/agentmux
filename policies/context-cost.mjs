import { choice, decide, defineDecisionTable, on } from "@v1d/product-spec";

/** WHAT: Defines context-cost thresholds. WHY: Keeps idle and wake decisions on the same documented budget. */
export const CONTEXT_COST_POLICY = Object.freeze({ maxTokens: 100_000, idleMs: 10 * 60_000, coldMs: 24 * 60 * 60_000 });

/** WHAT: Reads operator cost-policy overrides. WHY: Keeps daytime and cold-wake thresholds consistent after restart. */
export function readContextCostPolicy(env = process.env) {
  const policy = { maxTokens: Number(env.AUTO_COMPACT_MAX_TOKENS || CONTEXT_COST_POLICY.maxTokens),
    idleMs: Number(env.AUTO_COMPACT_MIN_IDLE_MS || CONTEXT_COST_POLICY.idleMs),
    coldMs: Number(env.AMUX_COLD_CONTEXT_IDLE_MS || CONTEXT_COST_POLICY.coldMs) };
  if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error("context-cost thresholds must be positive integers");
  return policy;
}

/** WHAT: Defines every context admission outcome. WHY: Prevents unknown evidence or failed compact from silently authorizing another paid attempt. */
export const contextCostDeclaration = {
  id: "amux.context-cost",
  axes: { need: ["NONE", "COMPACT", "UNKNOWN"], readiness: ["SAFE", "UNSAFE"], attempt: ["NEW", "VERIFIED", "FAILED"] },
  columns: { action: choice(["CONTINUE", "COMPACT", "HOLD"]) },
  cells: [
    on("within-policy", { need: "NONE" }, { action: "CONTINUE" }),
    on("unknown-evidence", { need: "UNKNOWN" }, { action: "HOLD" }),
    on("receipt-exists", { need: "COMPACT", attempt: "VERIFIED" }, { action: "CONTINUE" }),
    on("failed-attempt", { need: "COMPACT", attempt: "FAILED" }, { action: "HOLD" }),
    on("not-idle", { need: "COMPACT", attempt: "NEW", readiness: "UNSAFE" }, { action: "HOLD" }),
    on("compact-once", { need: "COMPACT", attempt: "NEW", readiness: "SAFE" }, { action: "COMPACT" }),
  ],
  invariants: [
    { refuse: "unknown context evidence cannot authorize model work", when: d => d.at.need === "UNKNOWN" && d.values.action !== "HOLD" },
    { refuse: "a failed compact cannot automatically spend another attempt", when: d => d.at.need === "COMPACT" && d.at.attempt === "FAILED" && d.values.action !== "HOLD" },
    { refuse: "compact requires proven safe idle", when: d => d.values.action === "COMPACT" && d.at.readiness !== "SAFE" },
  ],
};
/** WHAT: Builds the checked context-cost table. WHY: Prevents holes, overlaps and forbidden outcomes from reaching runtime. */
export const contextCostRules = defineDecisionTable(contextCostDeclaration);

/** WHAT: Maps observed context facts to a traceable decision cell. WHY: Keeps numeric thresholds outside effects and unknown values outside permissive defaults. */
export function contextCostDecision({ tokens, idleMs, cold = false, safe = false, attempt = "NEW" }, policy = CONTEXT_COST_POLICY) {
  const ageLimit = cold ? policy.coldMs : policy.idleMs;
  const need = (Number.isFinite(tokens) && tokens <= policy.maxTokens) || (Number.isFinite(idleMs) && idleMs < ageLimit)
    ? "NONE" : !Number.isFinite(tokens) || !Number.isFinite(idleMs) ? "UNKNOWN" : "COMPACT";
  return decide(contextCostRules, { need, readiness: safe ? "SAFE" : "UNSAFE", attempt });
}

/** WHAT: Defines every Codex launch admission. WHY: Prevents wake and recovery from bypassing compact-first model changes. */
export const codexLaunchRules = defineDecisionTable({
  id: "amux.codex-launch",
  axes: { identity: ["FRESH", "KNOWN", "UNKNOWN"], selection: ["SAME", "CHANGED"], receipt: ["VERIFIED", "MISSING"], blocked: ["YES", "NO"] },
  columns: { action: choice(["LAUNCH", "COMPACT", "HOLD"]) },
  cells: [
    on("previous-failure", { blocked: "YES" }, { action: "HOLD" }),
    on("unknown-model", { blocked: "NO", identity: "UNKNOWN" }, { action: "HOLD" }),
    on("fresh-session", { blocked: "NO", identity: "FRESH" }, { action: "LAUNCH" }),
    on("remembered-model", { blocked: "NO", identity: "KNOWN", selection: "SAME" }, { action: "LAUNCH" }),
    on("verified-change", { blocked: "NO", identity: "KNOWN", selection: "CHANGED", receipt: "VERIFIED" }, { action: "LAUNCH" }),
    on("compact-before-change", { blocked: "NO", identity: "KNOWN", selection: "CHANGED", receipt: "MISSING" }, { action: "COMPACT" }),
  ],
  invariants: [
    { refuse: "a changed existing model cannot launch without compact proof", when: d => d.at.identity === "KNOWN" && d.at.selection === "CHANGED" && d.at.receipt === "MISSING" && d.values.action === "LAUNCH" },
    { refuse: "blocked transitions cannot spend automatic retries", when: d => d.at.blocked === "YES" && d.values.action !== "HOLD" },
  ],
});

/** WHAT: Maps exact session and compact facts to the launch table. WHY: Keeps the model-change decision inspectable before any process side effect. */
export function codexLaunchDecision({ sessionId, previous, selected, blocked, receipt }) {
  return decide(codexLaunchRules, { identity: !sessionId ? "FRESH" : previous?.model ? "KNOWN" : "UNKNOWN",
    selection: previous?.model === selected?.model ? "SAME" : "CHANGED",
    receipt: receipt ? "VERIFIED" : "MISSING", blocked: blocked ? "YES" : "NO" });
}
