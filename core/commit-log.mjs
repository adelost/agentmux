// Cross-repo git log timeline for orchestrator check-ins. Commits are a
// stronger signal of actual work than jsonl activity: a jsonl can grow from
// meta-events (compact boundaries, file snapshots, tool_use bumps) without
// any new user-facing work. A new commit means code was written and kept.
//
// Pure wrapper around `git log` with a permissive error mode: non-repos and
// read failures return empty arrays so one broken directory can't kill the
// whole orchestrator view.

import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { basename } from "path";

const SEP = "\x1f"; // ASCII unit separator — safe against subjects containing | or tabs

/**
 * Run `git log --since=<iso>` in one repo and return parsed commits.
 * Returns [] for non-repos or any git failure (graceful degrade).
 *
 * @param {string} repo  - absolute path to a git working tree
 * @param {number} sinceMs - inclusive lower bound as epoch millis
 * @param {string} [label] - pretty name for display; defaults to basename(repo)
 * @returns {Array<{repo:string, label:string, hash:string, ts:number, subject:string}>}
 */
export function commitsFromRepo(repo, sinceMs, label = null) {
  if (!existsSync(repo)) return [];
  const iso = new Date(sinceMs).toISOString();
  const name = label || basename(repo);
  try {
    const fmt = `%H${SEP}%cI${SEP}%s`;
    const out = execFileSync(
      "git",
      ["-C", repo, "log", `--since=${iso}`, `--format=${fmt}`, "--no-merges"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const lines = out.split("\n").filter((l) => l.length > 0);
    return lines.map((line) => {
      const [hash, tsIso, ...rest] = line.split(SEP);
      const subject = rest.join(SEP);
      return { repo, label: name, hash, ts: Date.parse(tsIso), subject };
    }).filter((c) => Number.isFinite(c.ts));
  } catch {
    return [];
  }
}

/**
 * Merge `git log` output across many repos into one descending timeline.
 * De-duplicates repo paths by absolute string equality before querying so
 * the same repo isn't scanned twice when agents share a directory.
 *
 * @param {Array<{repo:string, label?:string}>} repos
 * @param {number} sinceMs
 * @param {number} [max] - hard cap on total commits returned (default 20)
 * @returns {Array<{repo:string, label:string, hash:string, ts:number, subject:string}>}
 */
export function collectCommitsSince(repos, sinceMs, max = 20) {
  const seen = new Set();
  const unique = [];
  for (const r of repos) {
    if (!r || !r.repo || seen.has(r.repo)) continue;
    seen.add(r.repo);
    unique.push(r);
  }

  const all = [];
  for (const r of unique) {
    const rows = commitsFromRepo(r.repo, sinceMs, r.label);
    all.push(...rows);
  }
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, max);
}

/**
 * Distinct (repo, label) pairs for a list of agents. Each agent's `dir` is
 * one repo candidate. Callers pass the merged result to collectCommitsSince.
 *
 * @param {Array<{name:string, dir:string}>} agents
 * @returns {Array<{repo:string, label:string}>}
 */
export function reposFromAgents(agents) {
  const out = [];
  const seen = new Set();
  for (const a of agents) {
    if (!a || !a.dir || seen.has(a.dir)) continue;
    seen.add(a.dir);
    out.push({ repo: a.dir, label: a.name });
  }
  return out;
}
