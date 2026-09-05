import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { check, OK, WARN, FAIL } from "./doctor.mjs";
import { discoverGitRoots, observeWorktreeOperation, readWorktrees, readWorkspaceGit } from "./git-workspaces.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW = "inspect this path with git status; preserve WIP and agree with its owner before completing or aborting the operation";

function optionalGit(path, args) {
  try { return readWorkspaceGit(path, args).trim(); }
  catch (error) {
    if (error.status === 1) return null;
    throw error;
  }
}

/** Use the remote's default branch; only fall back when main/master is unambiguous. */
function remoteTrunk(path) {
  const target = optionalGit(path, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (target) return { ref: target, branch: target.replace(/^refs\/remotes\/origin\//u, "") };
  const candidates = ["main", "master"].filter((branch) =>
    optionalGit(path, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${branch}`]) !== null);
  return candidates.length === 1 ? { ref: `refs/remotes/origin/${candidates[0]}`, branch: candidates[0] } : null;
}

/** Collect metadata only: no status/index refresh, network requests or cleanup. */
export function observeWorkspaceHealth(agents, { budgetMs = 15_000 } = {}) {
  const issues = [...new Set(agents.map((agent) => agent.dir).filter(Boolean))]
    .filter((path) => !existsSync(path)).map((path) => `${path}: configured workspace missing`);
  const repositories = [];
  const seen = new Set();
  const deadline = Date.now() + budgetMs;
  const roots = discoverGitRoots(agents.map((agent) => agent.dir), { onIssue: (issue) => issues.push(issue) });
  for (const root of roots) {
    if (Date.now() >= deadline) { issues.push(`workspace scan exceeded ${budgetMs}ms; remaining repositories not checked`); break; }
    try {
      const commonDir = realpathSync(resolve(root, readWorkspaceGit(root, ["rev-parse", "--git-common-dir"]).trim()));
      if (seen.has(commonDir)) continue;
      seen.add(commonDir);
      const worktrees = readWorktrees(root);
      const canonical = worktrees[0]; // Git lists its main working tree first.
      const repo = { root, canonical, worktrees, trunk: remoteTrunk(root), drift: null };
      repositories.push(repo);
      for (const tree of worktrees) {
        if (Date.now() >= deadline) { issues.push(`${root}: workspace scan budget reached; some paths not checked`); break; }
        tree.present = existsSync(tree.path);
        if (!tree.present || tree.bare) continue;
        try { tree.operation = observeWorktreeOperation(tree.path); }
        catch (error) { issues.push(`${tree.path}: Git operation unreadable (${error.code || error.message})`); }
      }
      if (canonical?.head && canonical.present && repo.trunk) {
        const counts = readWorkspaceGit(root, ["rev-list", "--left-right", "--count", `${canonical.head}...${repo.trunk.ref}`]).trim();
        const [ahead, behind] = counts.split(/\s+/u).map(Number);
        repo.drift = { ahead, behind };
      }
    } catch (error) {
      issues.push(`${root}: Git inventory unreadable (${String(error.stderr || error.code || error.message).trim().split("\n")[0]})`);
    }
  }
  return { repositories, issues };
}

/** Treat feature worktrees as normal; diagnose trunk ownership and main-tree drift. */
export function checkWorkspaceHealth({ repositories, issues = [] }, { now = Date.now(), staleAfterMs = DAY_MS } = {}) {
  const rows = issues.map((issue) => check("workspace scan", WARN, issue, "inspect the named path; incomplete coverage is not a clean bill of health"));
  for (const repo of repositories) {
    const { canonical, worktrees, trunk, drift } = repo;
    if (trunk) {
      const holders = worktrees.filter((tree) => tree.present && !tree.prunable && tree.branch === `refs/heads/${trunk.branch}`);
      if (holders.length > 1) rows.push(check("workspace trunk", FAIL,
        `${trunk.branch} checked out in ${holders.length} working trees: ${holders.map((tree) => tree.path).join(" | ")}`,
        "coordinate the named owners; preserve each tree's WIP before changing branch ownership"));
    }
    for (const tree of worktrees) {
      if (tree.present === false) rows.push(check("workspace path", WARN, `${tree.path}: registered worktree missing`, "inspect git worktree list --porcelain; verify ownership before manual cleanup"));
      if (!tree.operation) continue;
      const { name, markerPath, mtimeMs } = tree.operation;
      const ageMs = Math.max(0, now - mtimeMs);
      rows.push(check("workspace operation", ageMs >= staleAfterMs ? WARN : OK,
        `${tree.path}: ${name}; marker age ${Math.floor(ageMs / 3_600_000)}h (${markerPath})`, REVIEW));
    }
    if (!canonical || canonical.bare || !canonical.present) continue;
    if (!trunk) {
      rows.push(check("workspace canonical", WARN, `${canonical.path}: remote default branch unknown`,
        "inspect origin/HEAD and remote-tracking refs; no trunk or drift verdict is possible yet"));
      continue;
    }
    const branch = canonical.branch?.replace(/^refs\/heads\//u, "") || "detached HEAD";
    if (canonical.branch !== `refs/heads/${trunk.branch}` || drift?.behind > 0) {
      rows.push(check("workspace canonical", WARN,
        `${canonical.path}: ${branch}; expected ${trunk.branch}; ${drift?.ahead ?? "?"} ahead / ${drift?.behind ?? "?"} behind ${trunk.ref.replace("refs/remotes/", "")} (local snapshot)`,
        "check intent and WIP with the owner; fetch explicitly to refresh comparison before any fast-forward or branch switch"));
    }
  }
  if (!rows.length) rows.push(check("workspaces", OK,
    `${repositories.length} repositories checked; no duplicate trunk, stale operation or canonical drift against local remote-tracking refs`));
  return rows;
}
