// What a person reads after the janitor ran: one Markdown report per night,
// and at most one note on a repo's ÖPPET NU line when something there is red.
import { repoHygiene } from "../policies/repo-hygiene.mjs";

const OPEN_NOW = /^ÖPPET NU\b/u;
const JANITOR_NOTE = / \[janitor \d{4}-\d{2}-\d{2}:[^\]]*\]/u;

/** WHAT: Calculates how many things in a reviewed repo need a person. WHY: Keeps red to opened rows, unreadable facts and failures, not routine would-actions. */
export const redCount = (review) => (review.error ? 1 : 0)
  + (review.decisions ?? []).filter(({ values }) => values.opensRow).length
  + (review.unreadable ?? []).length;

const cellCounts = (decisions) => Object.entries(Object.groupBy(decisions, ({ cell }) => cell))
  .map(([cell, list]) => `${cell} ${list.length}`).join(", ");

const repoName = (common) => common.replace(/\/\.git$/u, "");

const actedRows = (entries) => entries.map(({ cell, action, target, sha, ageDays, restore }) =>
  `| ${cell.split("/").at(-1)} | ${action} | ${target}${sha ? ` @${sha.slice(0, 9)}` : ""} | ${ageDays} | ${restore ? `\`${restore}\`` : ""} |`);

function repoSection(review, entries) {
  if (review.error) return [`## ${repoName(review.common)}`, "", `FAILED: ${review.error}`, ""];
  const nothing = review.decisions.filter(({ values }) => values.action === "NOTHING");
  return [
    `## ${repoName(review.common)} (origin/${review.branch})`, "",
    `touchedToday ${review.touchedToday}${review.why.length ? `: ${review.why.join(", ")}` : ""}. Red: ${redCount(review)}.`, "",
    ...(review.originReviewedElsewhere ? [`Branches and plans of ${review.origin} are decided under its other clone above.`, ""] : []),
    ...(entries.length ? ["| Cell | Would | Target | Age (days) | Restore |", "|---|---|---|---|---|", ...actedRows(entries), ""] : []),
    `Decided NOTHING: ${nothing.length}${nothing.length ? ` (${cellCounts(nothing)})` : ""}.`,
    ...review.unreadable.map(({ kind, target, problem }) => `Unreadable ${kind}: ${target} (${problem}).`), "",
  ];
}

/** WHAT: Formats the night's Markdown report. WHY: Lets one page show every would-action and why each repo was or was not reviewed. */
export function renderReport({ startedAt, reviews, entriesByRepo, ledgerPath, warnings }) {
  const skipped = reviews.filter(({ skipped }) => skipped);
  return [
    `# Repo hygiene ${startedAt} (read-only: every action is "would", nothing was touched)`, "",
    `Table ${repoHygiene.id}: ${repoHygiene.cells.length} cells; refuses: ${repoHygiene.invariants.join("; ")}. Ledger: ${ledgerPath}.`, "",
    ...warnings.map((warning) => `WARNING: ${warning}`), ...(warnings.length ? [""] : []),
    ...reviews.filter(({ skipped }) => !skipped).flatMap((review) => repoSection(review, entriesByRepo.get(review.common) ?? [])),
    `## Not looked at: ${skipped.length} repos (no pane in it and no ref with a commit today)`, "",
    ...skipped.map(({ common }) => `- ${repoName(common)}`), "",
  ].join("\n");
}

/** WHAT: Returns ledger text with one janitor note on its ÖPPET NU line, or null. WHY: Keeps red nights visible where people look, without stacking a note per night. */
export function withOpenNowNote(ledgerText, { today, red, reportPath }) {
  const lines = ledgerText.split("\n");
  const index = lines.findIndex((line) => OPEN_NOW.test(line));
  if (index === -1) return null;
  const note = ` [janitor ${today}: ${red} red, read-only, report ${reportPath}]`;
  lines[index] = lines[index].replace(JANITOR_NOTE, "").trimEnd() + note;
  return lines.join("\n");
}
