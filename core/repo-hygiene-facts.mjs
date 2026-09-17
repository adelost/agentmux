// The facts the repo-hygiene table selects on, each read from git, tmux or
// the repo's .agents ledger. Nothing here decides; a fact that cannot be read
// comes back as `unreadable` with the reason, never as a guessed value.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";

const DAY_MS = 86_400_000;
const LEDGER = ".agents/0/TASKS.md";
const CLOSED_STATE = /\b(?:CLOSED|RELEASED|SUPERSEDED|DROPPED|STRUKEN|DONE|MERGED)\b/u;

const run = (command, args) => execFileSync(command, args, {
  encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
}).trim();
const git = (common, args) => run("git", [`--git-dir=${common}`, ...args]);
const lines = (text) => text.split("\n").filter(Boolean);
const ageDays = (now, atMs) => Math.floor((now - atMs) / DAY_MS);

/** WHAT: Resolves a path's shared git dir, or null outside any repo. WHY: Keeps a repo's checkouts and worktrees from counting as separate repos. */
export function commonDirOf(path) {
  try {
    return run("git", ["-C", path, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch {
    return null;
  }
}

/** WHAT: Returns a directory and its visible child directories. WHY: Lets one configured agent dir that holds many repos cover all of them. */
export function withChildDirs(dir) {
  if (!existsSync(dir)) return [];
  const children = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(dir, entry.name));
  return [dir, ...children];
}

/** WHAT: Reads every tmux pane's current directory on the amux socket. WHY: Lets a pane sitting in a repo prove the repo was touched today. */
export const paneDirs = (socket) => lines(run("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_current_path}"]));

/** WHAT: Resolves the main worktree of a shared git dir. WHY: Keeps ledger paths and restore commands on the main checkout instead of a linked worktree. */
export const mainWorktreeOf = (common) => lines(git(common, ["worktree", "list", "--porcelain"]))[0].replace(/^worktree /u, "");

/** WHAT: Checks whether any pane directory lies inside a directory. WHY: Keeps a worktree a pane uses from being named stale. */
export const hasPaneInside = (dirs, dir) => dirs.some((pane) => pane === dir || pane.startsWith(dir + sep));

/** WHAT: Checks whether any ref carries a commit dated since a moment. WHY: Limits network fetches to repos with a local sign of life today. */
export const anyRefMovedSince = (common, sinceMs) =>
  Number(git(common, ["for-each-ref", "--sort=-committerdate", "--count=1", "--format=%(committerdate:unix)"]) || 0) * 1000 >= sinceMs;

/** WHAT: Fetches origin with prune and names its default branch. WHY: Keeps every later fact on origin's refs instead of stale local ones. */
export function fetchDefaultBranch(common) {
  git(common, ["fetch", "--prune", "--quiet", "origin"]);
  const head = /^ref: refs\/heads\/(\S+)\tHEAD$/mu.exec(git(common, ["ls-remote", "--symref", "origin", "HEAD"]));
  if (!head) throw new Error("origin HEAD names no branch");
  return head[1];
}

/** WHAT: Reads the origin URL of a repo. WHY: Keeps two clones of one remote from reviewing its branches twice. */
export const originUrl = (common) => git(common, ["config", "--get", "remote.origin.url"]);

/** WHAT: Checks whether origin's default branch got a commit since a moment. WHY: Keeps touchedToday a git fact instead of a guess from timing. */
export const commitOnBranchSince = (common, branch, sinceMs) =>
  git(common, ["log", "-1", `--since=@${Math.floor(sinceMs / 1000)}`, "--format=%H", `origin/${branch}`]) !== "";

/** WHAT: Collects origin branches merged into the default branch, aged by their tip commit. WHY: Separates restorable deletion candidates from unmerged work. */
export function mergedBranches({ common, main, branch, now }) {
  return lines(git(common, ["for-each-ref", "refs/remotes/origin", `--merged=origin/${branch}`,
    "--format=%(refname:lstrip=3)%09%(objectname)%09%(committerdate:unix)%09%(symref)"]))
    .map((line) => line.split("\t"))
    .filter(([name, , , symref]) => name !== branch && !symref)
    .map(([name, sha, at]) => ({
      kind: "MERGED_BRANCH", target: `origin/${name}`, sha, ageDays: ageDays(now, Number(at) * 1000),
      restore: `git -C ${main} push origin ${sha}:refs/heads/${name}`,
    }));
}

/** WHAT: Collects docs/plans files nothing outside docs/plans names, aged by last commit. WHY: Keeps plans something still cites out of the archive. */
export function unreferencedPlans({ common, main, branch, now }) {
  const tree = `origin/${branch}`;
  const plans = lines(git(common, ["ls-tree", "--name-only", tree, "docs/plans/"]))
    .filter((path) => path.endsWith(".md") && basename(path) !== "README.md");
  if (plans.length === 0) return [];
  const referenced = new Set(lines(gitGrepMatches(common, [...plans.flatMap((path) => ["-e", basename(path)]), tree, "--", ".", ":!docs/plans"])));
  const lastCommit = new Map();
  let at = 0;
  for (const line of lines(git(common, ["log", "--format=@%ct", "--name-only", tree, "--", "docs/plans"]))) {
    if (line.startsWith("@")) at = Number(line.slice(1)) * 1000;
    else if (!lastCommit.has(line)) lastCommit.set(line, at);
  }
  return plans.filter((path) => !referenced.has(basename(path))).map((path) => ({
    kind: "UNREFERENCED_PLAN", target: path, ageDays: ageDays(now, lastCommit.get(path)),
    restore: `git -C ${main} mv docs/plans/archive/${basename(path)} ${path}`,
  }));
}

function gitGrepMatches(common, args) {
  try {
    return git(common, ["grep", "-o", "-h", "-F", ...args]);
  } catch (error) {
    if (error.status === 1) return "";
    throw error;
  }
}

/** WHAT: Collects closed .agents ledger rows, aged by the day amux first saw them closed. WHY: Keeps row age a fact, because the prose ledger lives outside git. */
export function closedLedgerRows({ common, main, now, today, firstSeen }) {
  const file = join(main, LEDGER);
  const seen = {};
  if (!existsSync(file)) return { candidates: [], unreadable: [], seen };
  const candidates = [];
  const unreadable = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const row = /^\| (\d+) \|/u.exec(line)?.[1];
    if (row === undefined) continue;
    const cells = line.split("|");
    if (cells.length !== 7) {
      unreadable.push({ kind: "CLOSED_LEDGER_ROW", target: `row ${row}`, problem: `${cells.length - 2} cells, the ledger has 5` });
      continue;
    }
    if (!CLOSED_STATE.test(cells[5])) continue;
    const key = `${common}#${row}`;
    seen[key] = firstSeen[key] ?? today;
    candidates.push({
      kind: "CLOSED_LEDGER_ROW", target: `${LEDGER} row ${row}`, ageDays: ageDays(now, Date.parse(seen[key])),
      restore: `move row ${row} from ${join(main, ".agents/0")}/TASKS-archive-<month>.md back to ${file}`,
    });
  }
  return { candidates, unreadable, seen };
}

// Age is the later of the HEAD commit and the last reflog entry: a detached worktree keeps no reflog.
/** WHAT: Collects unused linked worktrees whose HEAD is merged or whose directory is gone. WHY: Limits the kind to report-only naming, without inspecting uncommitted files. */
export function staleWorktrees({ common, branch, now, panes }) {
  const adminByPath = worktreeAdminDirs(common);
  const blocks = git(common, ["worktree", "list", "--porcelain"]).split("\n\n").slice(1);
  const heads = blocks.map((block) => /^HEAD (\w+)$/mu.exec(block)?.[1]).filter(Boolean);
  const commitMs = new Map(heads.length ? lines(git(common, ["log", "--no-walk", "--format=%H %ct", ...new Set(heads)]))
    .map((line) => line.split(" ")).map(([sha, at]) => [sha, Number(at) * 1000]) : []);
  const candidates = [];
  const unreadable = [];
  for (const block of blocks) {
    const path = /^worktree (.+)$/mu.exec(block)[1];
    const head = /^HEAD (\w+)$/mu.exec(block)?.[1];
    const prunable = /^prunable/mu.test(block);
    if (hasPaneInside(panes, path)) continue;
    if (!prunable && !head) {
      unreadable.push({ kind: "STALE_WORKTREE", target: path, problem: "no HEAD in git worktree list" });
      continue;
    }
    if (!prunable && !isAncestor(common, head, `origin/${branch}`)) continue;
    const lastMove = Math.max(commitMs.get(head) ?? 0, lastReflogMs(adminByPath.get(path)) ?? 0);
    if (lastMove === 0) unreadable.push({ kind: "STALE_WORKTREE", target: path, problem: "neither a HEAD commit nor a reflog to date it" });
    else candidates.push({ kind: "STALE_WORKTREE", target: path, sha: head, ageDays: ageDays(now, lastMove), restore: null });
  }
  return { candidates, unreadable };
}

function worktreeAdminDirs(common) {
  const root = join(common, "worktrees");
  if (!existsSync(root)) return new Map();
  return new Map(readdirSync(root).filter((id) => existsSync(join(root, id, "gitdir")))
    .map((id) => [dirname(readFileSync(join(root, id, "gitdir"), "utf8").trim()), join(root, id)]));
}

function isAncestor(common, commit, tip) {
  try {
    git(common, ["merge-base", "--is-ancestor", commit, tip]);
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function lastReflogMs(adminDir) {
  const log = adminDir && join(adminDir, "logs", "HEAD");
  if (!log || !existsSync(log)) return null;
  const at = /> (\d+) [+-]\d{4}\t/u.exec(lines(readFileSync(log, "utf8")).at(-1) ?? "")?.[1];
  return at === undefined ? null : Number(at) * 1000;
}
