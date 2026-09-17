// @ts-check
// amux policy: what happens to a stale thing in a repo, as a decision table.
// Every axis is a fact git or amux can prove; every action is reversible or a report.
// Plain .mjs, not .ts: the installed package lives under node_modules, where Node refuses to strip types.
import { bool, choice, defineDecisionTable, on } from "@v1d/product-spec";

/** @typedef {import("@v1d/product-spec").Decision} Decision */

/** WHAT: Defines the age axis day bounds; the first band above the age wins. WHY: Keeps thresholds beside the table instead of in the interpreter. */
export const AGE_BANDS = [
  { belowDays: 7, age: "UNDER_7D" },
  { belowDays: 30, age: "FROM_7_TO_30D" },
  { belowDays: Infinity, age: "OVER_30D" },
];

/** WHAT: Defines the repo-hygiene cells and invariants as plain data. WHY: Lets a test remove a cell and prove the table refuses the hole. */
export const repoHygieneDeclaration = {
  id: "amux.repo-hygiene",
  axes: {
    touchedToday: ["YES", "NO"],                       // a commit on the default branch today, or a pane's cwd in the repo
    kind: ["MERGED_BRANCH", "UNREFERENCED_PLAN", "CLOSED_LEDGER_ROW", "STALE_WORKTREE"],
    age: ["UNDER_7D", "FROM_7_TO_30D", "OVER_30D"],
  },
  columns: {
    action: choice(["NOTHING", "NAME_IN_REPORT", "ARCHIVE", "DELETE_WITH_SHA_LEDGER"]),
    opensRow: bool,                                   // a note on the repo's ÖPPET NU line for a person or pane
  },
  cells: [
    on("untouched", { touchedToday: "NO" }, { action: "NOTHING", opensRow: false }),
    on("fresh", { touchedToday: "YES", age: "UNDER_7D" }, { action: "NOTHING", opensRow: false }),
    on("branch.aging", { touchedToday: "YES", kind: "MERGED_BRANCH", age: "FROM_7_TO_30D" }, { action: "NAME_IN_REPORT", opensRow: false }),
    on("branch.old", { touchedToday: "YES", kind: "MERGED_BRANCH", age: "OVER_30D" }, { action: "DELETE_WITH_SHA_LEDGER", opensRow: false }),
    on("plan.aging", { touchedToday: "YES", kind: "UNREFERENCED_PLAN", age: "FROM_7_TO_30D" }, { action: "NAME_IN_REPORT", opensRow: false }),
    on("plan.old", { touchedToday: "YES", kind: "UNREFERENCED_PLAN", age: "OVER_30D" }, { action: "ARCHIVE", opensRow: false }),
    on("row.closed", { touchedToday: "YES", kind: "CLOSED_LEDGER_ROW", age: ["FROM_7_TO_30D", "OVER_30D"] }, { action: "ARCHIVE", opensRow: false }),
    on("worktree.stale", { touchedToday: "YES", kind: "STALE_WORKTREE", age: ["FROM_7_TO_30D", "OVER_30D"] }, { action: "NAME_IN_REPORT", opensRow: true }),
  ],
  invariants: [
    // The foolproof rule: nothing is deleted that git cannot restore. Only a merged branch has a SHA ledger.
    { refuse: "only a merged branch may be deleted, and only with its SHA in the ledger",
      when: (/** @type {Decision} */ d) => d.values.action === "DELETE_WITH_SHA_LEDGER" && d.at.kind !== "MERGED_BRANCH" },
    { refuse: "a repo nobody touched today costs nothing and is left alone",
      when: (/** @type {Decision} */ d) => d.at.touchedToday === "NO" && d.values.action !== "NOTHING" },
  ],
};

/** WHAT: Builds the checked repo-hygiene table. WHY: Stops the janitor from loading when any point lacks exactly one answer. */
export const repoHygiene = defineDecisionTable(repoHygieneDeclaration);
