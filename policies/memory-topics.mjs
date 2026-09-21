import { choice, decide, defineDecisionTable, on } from "@v1d/product-spec";

/** WHAT: Defines topic admission from observed evidence. WHY: Prevents stale or retired summaries from entering the retrieval boundary. */
export const memoryTopicDeclaration = {
  id: "amux.memory-topic",
  axes: { shape: ["VALID", "INVALID"], status: ["ACTIVE", "SUPERSEDED", "CONFLICT"], source: ["MATCH", "CHANGED", "UNAVAILABLE"] },
  columns: { state: choice(["READY", "INVALID", "SUPERSEDED", "CONFLICT", "STALE", "UNAVAILABLE"]), action: choice(["SERVE", "SOURCE_ONLY"]) },
  cells: [
    on("invalid-document", { shape: "INVALID" }, { state: "INVALID", action: "SOURCE_ONLY" }),
    on("retired-decision", { shape: "VALID", status: "SUPERSEDED" }, { state: "SUPERSEDED", action: "SOURCE_ONLY" }),
    on("unresolved-conflict", { shape: "VALID", status: "CONFLICT" }, { state: "CONFLICT", action: "SOURCE_ONLY" }),
    on("missing-evidence", { shape: "VALID", status: "ACTIVE", source: "UNAVAILABLE" }, { state: "UNAVAILABLE", action: "SOURCE_ONLY" }),
    on("changed-evidence", { shape: "VALID", status: "ACTIVE", source: "CHANGED" }, { state: "STALE", action: "SOURCE_ONLY" }),
    on("verified-sources", { shape: "VALID", status: "ACTIVE", source: "MATCH" }, { state: "READY", action: "SERVE" }),
  ],
  invariants: [
    { refuse: "only active topics with matching readable evidence may be served", when: d => d.values.action === "SERVE"
      && (d.at.shape !== "VALID" || d.at.status !== "ACTIVE" || d.at.source !== "MATCH") },
  ],
};

/** WHAT: Builds the complete topic decision table. WHY: Prevents missing or overlapping policy cells from reaching retrieval. */
export const memoryTopicRules = defineDecisionTable(memoryTopicDeclaration);

/** WHAT: Returns the topic state and its deciding cell. WHY: Makes each admission inspectable without duplicating policy in callers. */
export const decideMemoryTopic = facts => decide(memoryTopicRules, facts);
