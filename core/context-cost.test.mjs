import { feature, unit, expect } from "bdd-vitest";
import { defineDecisionTable, decisionPoints, decide } from "@v1d/product-spec";
import { codexLaunchDecision, codexResumeContext, contextCostDeclaration, contextCostRules, contextCostDecision,
  readContextCostPolicy } from "../policies/context-cost.mjs";
import { decideAutoCompactAction, DEFAULT_CONFIG } from "./auto-compact.mjs";

feature("context-cost decisions are total and fail closed", () => {
  unit("the DSL refuses a missing or overlapping cell", {
    then: ["both malformed policies fail at declaration", () => {
      expect(() => defineDecisionTable({ ...contextCostDeclaration, cells: contextCostDeclaration.cells.slice(1) })).toThrow(/no cell/);
      expect(() => defineDecisionTable({ ...contextCostDeclaration, cells: [...contextCostDeclaration.cells, { ...contextCostDeclaration.cells[0], id: "overlap" }] })).toThrow(/covered by 2/);
      expect(decisionPoints(contextCostRules.axes).every(p => decide(contextCostRules, p).cell)).toBe(true);
    }],
  });
  for (const [name, facts, action] of [
    ["a 473k panel is eligible after one quiet hour despite its million-token window", { tokens: 473_000, idleMs: 3_600_000, safe: true }, "COMPACT"],
    ["100k exactly is within the chosen budget", { tokens: 100_000, idleMs: 600_000, safe: true }, "CONTINUE"],
    ["a recent conversation is left alone", { tokens: 473_000, idleMs: 599_999, safe: true }, "CONTINUE"],
    ["24 hours and a large context require compact before work", { tokens: 473_000, idleMs: 86_400_000, cold: true, safe: true }, "COMPACT"],
    ["a cold 250k context is compacted before its first prompt", { tokens: 250_000, idleMs: 86_400_000, cold: true, safe: true }, "COMPACT"],
    ["a cold 150k context is cheaper to send than to compact", { tokens: 150_000, idleMs: 86_400_000, cold: true, safe: true }, "CONTINUE"],
    ["a cold 72k context can continue without paid compact", { tokens: 72_000, idleMs: 86_400_000, cold: true, safe: true }, "CONTINUE"],
    ["unknown cold context remains held", { tokens: null, idleMs: 86_400_000, cold: true, safe: true }, "HOLD"],
    ["a failed compact blocks a cold wake", { tokens: 473_000, idleMs: 86_400_000, cold: true, safe: true, attempt: "FAILED" }, "HOLD"],
    ["unknown age cannot authorize maintenance", { tokens: 473_000, idleMs: NaN, cold: true, safe: true }, "HOLD"],
    ["busy large contexts are never compacted", { tokens: 473_000, idleMs: 86_400_000, cold: true, safe: false }, "HOLD"],
  ]) unit(name, {
    given: ["observed pane facts", () => facts],
    when: ["evaluating the declared policy", f => contextCostDecision(f)],
    then: ["the named cell enforces the cost boundary", d => expect(d.values.action).toBe(action)],
  });
  unit("runtime policy compacts a cold context from its 210k break-even", {
    when: ["reading the policy used by delivery admission", () => contextCostDecision({
      tokens: 211_000, idleMs: 86_400_000, cold: true, safe: true,
    }, readContextCostPolicy({}))],
    then: ["the first cold prompt compacts before delivery", d => expect(d.values.action).toBe("COMPACT")],
  });
  unit("daytime auto-compact sees a large context below its percentage threshold", {
    given: ["a 473k pane at 56%, idle 55 minutes inside the warm cache", () => ({ paneKey: "claw:2", status: "idle", contextPercent: 56,
      contextTokens: 473_000, paneInMode: "0", lastActivityMs: 0, warnings: new Map(), config: DEFAULT_CONFIG, now: 55 * 60_000 })],
    when: ["polling the existing controller policy", args => decideAutoCompactAction(args)],
    then: ["the warning begins before the absolute-budget compact", d => expect(d.action).toBe("warn")],
  });
});

feature("Codex launch admission for a resumed session", () => {
  const known = { sessionId: "s4", previous: { model: "gpt-6.1-sol" }, selected: { model: "gpt-6.1-sol" } };
  // Mattias 2026-10-13: compact before a session resumes; a failed or unknown
  // compact holds automatic work instead of starting it on the cold context.
  unit("a cold large session compacts first, and only a verified compact or its owner releases a tried one", {
    when: ["deciding each context", () => [
      codexLaunchDecision({ ...known, context: "COLD_LARGE" }),
      codexLaunchDecision({ ...known, context: "COLD_LARGE", receipt: true }),
      codexLaunchDecision({ ...known, context: "TRIED" }),
      codexLaunchDecision({ ...known, context: "TRIED", receipt: true }),
      codexLaunchDecision({ ...known, context: "TRIED", work: "HUMAN" }),
      codexLaunchDecision({ ...known, context: "TRIED", selected: { model: "gpt-6.2-sol" } }),
      codexLaunchDecision({ ...known, context: "WITHIN" })].map(d => `${d.cell}:${d.values.action}`)],
    then: ["automatic work never starts or pays again after an unverified compact", cells => expect(cells).toEqual([
      "compact-before-resume:COMPACT", "compacted-resume:LAUNCH", "compact-tried:HOLD", "compacted-resume:LAUNCH",
      "owner-after-failed-compact:LAUNCH", "compact-tried:HOLD", "remembered-model:LAUNCH"])],
  });
  unit("the resume context uses the Codex before-delivery limits", {
    when: ["classifying skyvw:4 and its neighbours", () => [
      codexResumeContext({ tokens: 409_537, idleMs: 94 * 60_000 }),
      codexResumeContext({ tokens: 150_000, idleMs: 94 * 60_000 }),
      codexResumeContext({ tokens: 409_537, idleMs: 24 * 60_000 }),
      codexResumeContext({ tokens: NaN, idleMs: 94 * 60_000 }),
      codexResumeContext({ tokens: 409_537, idleMs: 94 * 60_000, tried: true })]],
    then: ["over 150k and 25 quiet minutes is cold and large; unknown tokens start as today", r => expect(r).toEqual(
      ["COLD_LARGE", "WITHIN", "WITHIN", "WITHIN", "TRIED"])],
  });
});
