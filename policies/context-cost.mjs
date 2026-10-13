import { choice, decide, defineDecisionTable, on } from "@v1d/product-spec";

// Mattias 2026-09-26: "sänka gränsen så att alla paneler har varit idle i 50
// minuter så kör man kompakt nästan oavsett och sen så finns det ett kvitto".
// Claude's prompt cache lives one hour: compacting after 50 quiet minutes reads
// a warm cache, while the next prompt after 60 re-bills the whole context. The
// 80k floor sits just above a freshly compacted session (system prompt, tools
// and summary), so one message after a compact does not trigger another.
//
// A cold cache (idle past the hour) makes the compact itself re-read the whole
// context C: about 1.25C plus a ~30k summary, then 2 x 65k to write the small
// context, against 2C for simply sending the prompt. That only pays below
// C = 210k on the first message, so a cold context is compacted from 210k.
// Mattias: "måste du vara helt säker på att det skulle minska kostnaden".
/** WHAT: Defines context-cost thresholds. WHY: Keeps idle and wake decisions on the same documented budget. */
export const CONTEXT_COST_POLICY = Object.freeze({ maxTokens: 80_000, coldMaxTokens: 210_000,
  idleMs: 50 * 60_000, coldMs: 60 * 60_000 });

// skyvw:0 2026-10-11, on Mattias's "det verkar ju funka bra om du kompakterar
// vid rimliga punkter också för att spara pengar": busy builders never rest 50
// minutes (median pause 1.5-7 min overnight), so a Claude pane is also compacted
// once its turn has ended. Leaders carry the plan and the conversation with
// Mattias, so they keep more context.
// skyvw:0 2026-10-11, on Mattias's "Borde autocompact bara vara tjugo minuter för
// Codex eller tjugofem minuter": OpenAI keeps a GPT-5.6+ prefix "for 30 minutes
// after its most recent write or reuse", and our Codex compacts were 83% cached
// 5-30 minutes after the last call against 43% after 60. Codex compacts an idle
// pane after 25 minutes; Claude, whose cache lives an hour, keeps 50.
// A Codex compact leaves about 94k (median of the next call), so it pays back
// after 94k / (0.05 x (C - 94k)) calls: 313 at 100k, 34 at 150k, 7 at 370k.
// Sessions made about 90 calls per compact, so Codex compacts from 150k.
/** WHAT: Defines compaction at a natural pause. WHY: Keeps busy panes from growing past 700k between 50-minute rests that never come. */
export const PAUSE_COMPACT_POLICY = Object.freeze({ builderTokens: 400_000, leaderTokens: 700_000,
  settleMs: 60_000, spacingMs: 30 * 60_000, backgroundQuietMs: 5 * 60_000, hungJobMs: 60 * 60_000,
  codexIdleMs: 25 * 60_000, codexMinTokens: 150_000 });

/** WHAT: Reads operator cost-policy overrides. WHY: Keeps daytime and cold-wake thresholds consistent after restart. */
export function readContextCostPolicy(env = process.env) {
  const maxTokens = Number(env.AUTO_COMPACT_MAX_TOKENS || CONTEXT_COST_POLICY.maxTokens);
  const policy = { maxTokens, coldMaxTokens: CONTEXT_COST_POLICY.coldMaxTokens,
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
export function contextCostDecision({ tokens, idleMs, cold = false, pauseTokens = null, pauseSettleMs = PAUSE_COMPACT_POLICY.settleMs,
  safe = false, attempt = "NEW" }, policy = CONTEXT_COST_POLICY) {
  const ageLimit = cold ? policy.coldMs : pauseTokens ? pauseSettleMs : policy.idleMs;
  const tokenLimit = cold ? policy.coldMaxTokens ?? policy.maxTokens : pauseTokens ?? policy.maxTokens;
  const need = (Number.isFinite(tokens) && tokens <= tokenLimit) || (Number.isFinite(idleMs) && idleMs < ageLimit)
    ? "NONE" : !Number.isFinite(tokens) || !Number.isFinite(idleMs) ? "UNKNOWN" : "COMPACT";
  return decide(contextCostRules, { need, readiness: safe ? "SAFE" : "UNSAFE", attempt });
}

// skyvw:4, 2026-10-13: after a host restart Codex resumed a 409k session quiet
// for 94 minutes and its active goal started a turn at once, before any amux
// gate. A resumed session past the before-delivery rule (over 150k, 25 quiet
// minutes) is compacted first. TRIED means a compact of this context was
// already attempted with no work since; it starts without another paid attempt.
/** WHAT: Defines every Codex launch admission. WHY: Prevents wake and recovery from bypassing compact-first model changes. */
export const codexLaunchRules = defineDecisionTable({
  id: "amux.codex-launch",
  axes: { identity: ["FRESH", "KNOWN", "UNKNOWN"], selection: ["SAME", "CHANGED"], receipt: ["VERIFIED", "MISSING"], blocked: ["YES", "NO"],
    context: ["WITHIN", "COLD_LARGE", "TRIED"] },
  columns: { action: choice(["LAUNCH", "COMPACT", "HOLD"]) },
  cells: [
    on("previous-failure", { blocked: "YES" }, { action: "HOLD" }),
    on("unknown-model", { blocked: "NO", identity: "UNKNOWN" }, { action: "HOLD" }),
    on("fresh-session", { blocked: "NO", identity: "FRESH" }, { action: "LAUNCH" }),
    on("remembered-model", { blocked: "NO", identity: "KNOWN", selection: "SAME", context: "WITHIN" }, { action: "LAUNCH" }),
    on("compact-tried", { blocked: "NO", identity: "KNOWN", selection: "SAME", context: "TRIED" }, { action: "LAUNCH" }),
    on("compacted-resume", { blocked: "NO", identity: "KNOWN", selection: "SAME", context: "COLD_LARGE", receipt: "VERIFIED" }, { action: "LAUNCH" }),
    on("compact-before-resume", { blocked: "NO", identity: "KNOWN", selection: "SAME", context: "COLD_LARGE", receipt: "MISSING" }, { action: "COMPACT" }),
    on("verified-change", { blocked: "NO", identity: "KNOWN", selection: "CHANGED", receipt: "VERIFIED" }, { action: "LAUNCH" }),
    on("compact-before-change", { blocked: "NO", identity: "KNOWN", selection: "CHANGED", receipt: "MISSING" }, { action: "COMPACT" }),
  ],
  invariants: [
    { refuse: "a changed existing model cannot launch without compact proof", when: d => d.at.identity === "KNOWN" && d.at.selection === "CHANGED" && d.at.receipt === "MISSING" && d.values.action === "LAUNCH" },
    { refuse: "a cold large session cannot resume before its compact", when: d => d.at.identity === "KNOWN" && d.at.context === "COLD_LARGE" && d.at.receipt === "MISSING" && d.values.action === "LAUNCH" },
    { refuse: "blocked transitions cannot spend automatic retries", when: d => d.at.blocked === "YES" && d.values.action !== "HOLD" },
  ],
});

/** WHAT: Maps a resumed Codex session's size and quiet time to its launch context. WHY: Keeps launch on Codex's before-delivery limits. */
export function codexResumeContext({ tokens, idleMs, tried = false }, policy = PAUSE_COMPACT_POLICY) {
  const coldLarge = Number.isFinite(tokens) && tokens > policy.codexMinTokens && Number.isFinite(idleMs) && idleMs >= policy.codexIdleMs;
  return !coldLarge ? "WITHIN" : tried ? "TRIED" : "COLD_LARGE";
}

/** WHAT: Maps exact session and compact facts to the launch table. WHY: Keeps the model-change decision inspectable before any process side effect. */
export function codexLaunchDecision({ sessionId, previous, selected, blocked, receipt, context = "WITHIN" }) {
  return decide(codexLaunchRules, { identity: !sessionId ? "FRESH" : previous?.model ? "KNOWN" : "UNKNOWN",
    selection: previous?.model === selected?.model ? "SAME" : "CHANGED",
    receipt: receipt ? "VERIFIED" : "MISSING", blocked: blocked ? "YES" : "NO", context });
}
