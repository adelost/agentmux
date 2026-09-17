import { defineDecisionTable } from "@v1d/product-spec";
import { expect, feature, unit } from "bdd-vitest";
import { repoHygieneDeclaration } from "./repo-hygiene.mjs";

const refusal = (declaration) => {
  try {
    defineDecisionTable(declaration);
    return null;
  } catch (error) {
    return error.message;
  }
};

feature("repo-hygiene policy refuses to build when it is not one answer per point", () => {
  unit("a deleted cell leaves a hole the table names instead of skipping", {
    given: ["the janitor's table without the cell for old merged branches", () => ({
      ...repoHygieneDeclaration,
      cells: repoHygieneDeclaration.cells.filter(({ id }) => id !== "branch.old"),
    })],
    when: ["the table is defined", refusal],
    then: ["it is refused at the uncovered point", (message) =>
      expect(message).toContain("no cell covers touchedToday=YES kind=MERGED_BRANCH age=OVER_30D")],
  });

  unit("a cell that deletes an old plan is refused: only a merged branch has a SHA to restore", {
    given: ["the janitor's table with old plans deleted instead of archived", () => ({
      ...repoHygieneDeclaration,
      cells: repoHygieneDeclaration.cells.map((cell) => (cell.id === "plan.old"
        ? { ...cell, values: { ...cell.values, action: "DELETE_WITH_SHA_LEDGER" } } : cell)),
    })],
    when: ["the table is defined", refusal],
    then: ["the invariant names the cell and the point", (message) =>
      expect(message).toContain("cell plan.old at touchedToday=YES kind=UNREFERENCED_PLAN age=OVER_30D: only a merged branch may be deleted")],
  });
});
