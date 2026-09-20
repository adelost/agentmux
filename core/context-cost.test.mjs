import { feature, unit, expect } from "bdd-vitest";
import { defineDecisionTable, decisionPoints, decide } from "@v1d/product-spec";
import { contextCostDeclaration, contextCostRules, contextCostDecision } from "../policies/context-cost.mjs";
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
    ["a 473k idle panel is eligible despite its million-token window", { tokens: 473_000, idleMs: 600_000, safe: true }, "COMPACT"],
    ["100k exactly is within the chosen budget", { tokens: 100_000, idleMs: 600_000, safe: true }, "CONTINUE"],
    ["a recent conversation is left alone", { tokens: 473_000, idleMs: 599_999, safe: true }, "CONTINUE"],
    ["24 hours and a large context require compact before work", { tokens: 473_000, idleMs: 86_400_000, cold: true, safe: true }, "COMPACT"],
    ["a failed compact blocks a cold wake", { tokens: 473_000, idleMs: 86_400_000, cold: true, safe: true, attempt: "FAILED" }, "HOLD"],
    ["unknown age cannot authorize maintenance", { tokens: 473_000, idleMs: NaN, cold: true, safe: true }, "HOLD"],
    ["busy large contexts are never compacted", { tokens: 473_000, idleMs: 86_400_000, cold: true, safe: false }, "HOLD"],
  ]) unit(name, {
    given: ["observed pane facts", () => facts],
    when: ["evaluating the declared policy", f => contextCostDecision(f)],
    then: ["the named cell enforces the cost boundary", d => expect(d.values.action).toBe(action)],
  });
  unit("daytime auto-compact sees a large context below its percentage threshold", {
    given: ["a 473k pane at 56%, idle ten minutes", () => ({ paneKey: "claw:2", status: "idle", contextPercent: 56,
      contextTokens: 473_000, paneInMode: "0", lastActivityMs: 0, warnings: new Map(), config: DEFAULT_CONFIG, now: 600_000 })],
    when: ["polling the existing controller policy", args => decideAutoCompactAction(args)],
    then: ["the warning begins before the absolute-budget compact", d => expect(d.action).toBe("warn")],
  });
});
