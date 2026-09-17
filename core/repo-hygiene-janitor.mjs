// The janitor's whole decision: facts in, one table decision per candidate,
// a ledger line per action the cell names. Read-only for now: every action is
// recorded as "would" and nothing in a repo is touched.
import { decide, decisionPoints } from "@v1d/product-spec";
import { AGE_BANDS, repoHygiene } from "../policies/repo-hygiene.mjs";
import {
  anyRefMovedSince, closedLedgerRows, commitOnBranchSince, fetchDefaultBranch,
  mainWorktreeOf, mergedBranches, originUrl, staleWorktrees, unreferencedPlans,
} from "./repo-hygiene-facts.mjs";

const ACTIONS_THAT_ACT = new Set(["NAME_IN_REPORT", "ARCHIVE", "DELETE_WITH_SHA_LEDGER"]);

/** WHAT: Maps an age in days to the table's age axis value. WHY: Keeps the day thresholds beside the table instead of in this interpreter. */
export const ageAxis = (days) => AGE_BANDS.find(({ belowDays }) => days < belowDays).age;

/** WHAT: Checks that the table answers NOTHING at every untouched point. WHY: Lets untouched repos go unlisted only because the table says so. */
export const untouchedRepoCostsNothing = (table = repoHygiene) => decisionPoints(table.axes)
  .filter((point) => point.touchedToday === "NO")
  .every((point) => decide(table, point).values.action === "NOTHING");

/** WHAT: Returns one table decision per candidate, carrying the deciding cell id. WHY: Keeps every recorded action traceable to the rule that fired. */
export const decideCandidates = (touchedToday, candidates, table = repoHygiene) => candidates.map((candidate) => ({
  ...candidate, ...decide(table, { touchedToday, kind: candidate.kind, age: ageAxis(candidate.ageDays) }),
}));

/** WHAT: Builds a ledger entry per decision whose cell acts. WHY: Preserves cell id, target and restore command while every action stays a would. */
export const ledgerEntries = ({ repo, decisions, at }) => decisions
  .filter(({ values }) => ACTIONS_THAT_ACT.has(values.action))
  .map(({ cell, values, kind, target, sha, ageDays, restore }) => ({
    at, mode: "would", repo, cell: `${repoHygiene.id}/${cell}`, action: values.action, opensRow: values.opensRow,
    kind, target, ...(sha ? { sha } : {}), ageDays, restore: values.action === "NAME_IN_REPORT" ? null : restore,
  }));

// [panes] holds { dir, common } for each tmux pane. [reviewedOrigins] collects origin URLs whose
// branches and plans are already decided tonight, since a second clone shares them.
/** WHAT: Reads one repo's facts and decides every candidate with the table. WHY: Keeps unreadable facts visible as red instead of guessed values. */
export function reviewRepo({ common, panes, now, sinceMs, today, firstSeen, reviewedOrigins }) {
  const untouchedIsFree = untouchedRepoCostsNothing();
  const paneInRepo = panes.some((pane) => pane.common === common);
  if (untouchedIsFree && !paneInRepo && !anyRefMovedSince(common, sinceMs)) {
    return { common, skipped: "no pane in it and no ref with a commit today" };
  }
  const branch = fetchDefaultBranch(common);
  const commitToday = commitOnBranchSince(common, branch, sinceMs);
  const touchedToday = paneInRepo || commitToday ? "YES" : "NO";
  const why = [paneInRepo && "a pane's cwd is in it", commitToday && `a commit on origin/${branch} today`].filter(Boolean);
  // No `seen` until the ledger was read, so an untouched night keeps the first-seen dates.
  const reviewed = { common, branch, touchedToday, why, decisions: [], unreadable: [] };
  if (touchedToday === "NO" && untouchedIsFree) return reviewed;
  const facts = { common, main: mainWorktreeOf(common), branch, now, today, firstSeen, panes: panes.map(({ dir }) => dir) };
  const origin = originUrl(common);
  const originReviewedElsewhere = reviewedOrigins.has(origin);
  reviewedOrigins.add(origin);
  const rows = closedLedgerRows(facts);
  const worktrees = staleWorktrees(facts);
  const originCandidates = originReviewedElsewhere ? [] : [...mergedBranches(facts), ...unreferencedPlans(facts)];
  const candidates = [...originCandidates, ...rows.candidates, ...worktrees.candidates];
  return {
    ...reviewed, origin, originReviewedElsewhere, decisions: decideCandidates(touchedToday, candidates),
    unreadable: [...rows.unreadable, ...worktrees.unreadable], seen: rows.seen,
  };
}
