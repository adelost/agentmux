// Real git on a throwaway origin and clone: the janitor reads every kind of
// candidate, decides each with the table, and touches nothing in the repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, feature, integration } from "bdd-vitest";
import { commonDirOf, mainWorktreeOf } from "./repo-hygiene-facts.mjs";
import { ledgerEntries, reviewRepo } from "./repo-hygiene-janitor.mjs";

const JANITOR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "bin", "janitor.mjs");
const DAY_S = 86_400;
const git = (cwd, args, env = {}) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...env } }).trim();

function commitDaysAgo(work, file, daysAgo, text = file) {
  mkdirSync(dirname(join(work, file)), { recursive: true });
  writeFileSync(join(work, file), `${text}\n`);
  const date = `@${Math.floor(Date.now() / 1000) - daysAgo * DAY_S} +0000`;
  git(work, ["add", file]);
  git(work, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", file], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(work, ["rev-parse", "HEAD"]);
}

function repoWithEveryKind() {
  const root = mkdtempSync(join(tmpdir(), "repo-hygiene-"));
  const work = join(root, "work");
  git(root, ["init", "-q", "--bare", "-b", "main", "origin.git"]);
  git(root, ["init", "-q", "-b", "main", "work"]);
  git(work, ["remote", "add", "origin", join(root, "origin.git")]);
  commitDaysAgo(work, "README.md", 60, "see docs/plans/referenced-plan.md");
  commitDaysAgo(work, "docs/plans/referenced-plan.md", 40);
  const oldMerged = commitDaysAgo(work, "docs/plans/old-plan.md", 40);
  git(work, ["branch", "old-merged"]);
  commitDaysAgo(work, "aging.txt", 10);
  git(work, ["branch", "aging-merged"]);
  git(work, ["checkout", "-q", "-b", "unmerged"]);
  commitDaysAgo(work, "unmerged.txt", 40);
  git(work, ["checkout", "-q", "main"]);
  commitDaysAgo(work, "today.txt", 0);
  git(work, ["push", "-q", "origin", "main", "old-merged", "aging-merged", "unmerged"]);
  git(work, ["worktree", "add", "-q", "--detach", join(root, "stale-worktree"), oldMerged]);
  mkdirSync(join(work, ".agents", "0"), { recursive: true });
  writeFileSync(join(work, ".agents", "0", "TASKS.md"), [
    "# Tasks", "", "ÖPPET NU (test): one lane.", "",
    "| # | Task | Owner | Done when | State |", "|---|---|---|---|---|",
    "| 5 | an old row | a | b | CLOSED 09:33 by x |", "| 6 | an open row | a | b | opened today |", "",
  ].join("\n"));
  const common = commonDirOf(work);
  return { root, work, common, main: mainWorktreeOf(common), oldMerged };
}

const cellByTarget = (decisions) => Object.fromEntries(decisions.map(({ target, cell }) => [target, cell]));

feature("the repo-hygiene janitor decides every candidate by the table and touches nothing", () => {
  integration("each kind lands in its cell, with a restore command, and origin keeps every branch", {
    given: ["a repo touched today with merged, unmerged, planned, closed and worktree leftovers", repoWithEveryKind],
    when: ["the janitor reviews it, having first seen row 5 closed ten days ago", (fixture) => {
      const now = Date.now();
      const tenDaysAgo = new Date(now - 10 * DAY_S * 1000).toISOString().slice(0, 10);
      const review = reviewRepo({
        common: fixture.common, panes: [], now, sinceMs: new Date(now).setHours(0, 0, 0, 0), today: "unused",
        firstSeen: { [`${fixture.common}#5`]: tenDaysAgo }, reviewedOrigins: new Set(),
      });
      return { review, entries: ledgerEntries({ repo: fixture.common, decisions: review.decisions, at: "now" }) };
    }],
    then: ["the table's cells decided, the old branch would be deleted with its SHA, and nothing was", ({ review, entries }, fixture) => {
      expect(review.touchedToday).toBe("YES");
      expect(cellByTarget(review.decisions)).toEqual({
        "origin/old-merged": "branch.old",
        "origin/aging-merged": "branch.aging",
        "docs/plans/old-plan.md": "plan.old",
        ".agents/0/TASKS.md row 5": "row.closed",
        [join(fixture.root, "stale-worktree")]: "worktree.stale",
      });
      expect(entries.find(({ target }) => target === "origin/old-merged")).toMatchObject({
        mode: "would", cell: "amux.repo-hygiene/branch.old", action: "DELETE_WITH_SHA_LEDGER",
        restore: `git -C ${fixture.main} push origin ${fixture.oldMerged}:refs/heads/old-merged`,
      });
      expect(git(fixture.work, ["ls-remote", "--heads", "origin"]).split("\n")).toHaveLength(4);
    }],
    cleanup: (fixture) => rmSync(fixture.root, { recursive: true, force: true }),
  });

  integration("a red night leaves one janitor note on the ÖPPET NU line, replaced rather than stacked", {
    given: ["the same repo, whose stale worktree opens a row", repoWithEveryKind],
    when: ["the janitor command runs twice", (fixture) => {
      const env = { ...process.env, TMUX_SOCKET: "" };
      const run = () => execFileSync(process.execPath, [JANITOR, "--repo", fixture.work, "--state-dir", join(fixture.root, "state")], { env, encoding: "utf8" });
      run();
      return { output: run(), ledger: readFileSync(join(fixture.work, ".agents", "0", "TASKS.md"), "utf8") };
    }],
    then: ["the note is there once, says read-only and counts the red worktree", ({ output, ledger }) => {
      expect(output).toContain("1 red");
      expect(ledger.match(/\[janitor /gu)).toHaveLength(1);
      expect(ledger).toMatch(/^ÖPPET NU \(test\): one lane\. \[janitor \d{4}-\d{2}-\d{2}: 1 red, read-only, report /mu);
    }],
    cleanup: (fixture) => rmSync(fixture.root, { recursive: true, force: true }),
  });
});
