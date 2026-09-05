// Shared read-only discovery for restart inventory and workspace health.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** Run bounded Git reads without refreshing an index or lazily fetching objects. */
export function readWorkspaceGit(path, args) {
  return execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8", timeout: 2_000, maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Reuse the restart inventory's bounded search under configured agent directories. */
export function discoverGitRoots(seeds, { maxDepth = 3, maxEntries = 2_000, onIssue = () => {} } = {}) {
  const roots = new Set();
  const seen = new Set();
  let visited = 0;
  let limitReported = false;
  const walk = (path, depth) => {
    const absolute = resolve(path);
    if (depth > maxDepth || seen.has(absolute) || !existsSync(absolute)) return;
    if (visited >= maxEntries) {
      if (!limitReported) onIssue(`discovery limited to ${maxEntries} directories; remaining roots not checked`);
      limitReported = true;
      return;
    }
    seen.add(absolute);
    visited++;
    if (existsSync(join(absolute, ".git"))) {
      roots.add(absolute);
      return;
    }
    let entries;
    try { entries = readdirSync(absolute, { withFileTypes: true }); }
    catch (error) { onIssue(`${absolute}: ${error.code || error.message}`); return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || ["node_modules", ".git", "build", "dist", ".cache"].includes(entry.name)) continue;
      walk(join(absolute, entry.name), depth + 1);
    }
  };
  // Inspect all explicitly configured roots before spending the recursive budget.
  for (const seed of seeds.filter(Boolean)) {
    if (existsSync(join(resolve(seed), ".git"))) roots.add(resolve(seed));
  }
  for (const seed of seeds.filter(Boolean)) walk(seed, 0);
  return roots;
}

/** Resolve operation markers through Git so linked worktrees use their own metadata. */
export function observeWorktreeOperation(path) {
  const gitDir = readWorkspaceGit(path, ["rev-parse", "--absolute-git-dir"]).trim();
  for (const [name, marker] of [
    ["rebase", "rebase-merge"], ["rebase", "rebase-apply"],
    ["merge", "MERGE_HEAD"], ["cherry-pick", "CHERRY_PICK_HEAD"],
    ["revert", "REVERT_HEAD"], ["sequencer", "sequencer"],
  ]) {
    const markerPath = join(gitDir, marker);
    try { return { name, markerPath, mtimeMs: statSync(markerPath).mtimeMs }; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return null;
}

/** Parse NUL porcelain; spaces, Unicode and newlines in paths remain exact. */
export function parseWorktrees(porcelain) {
  return porcelain.split("\0\0").filter(Boolean).map((record) => {
    const fields = record.split("\0");
    const value = (key) => fields.find((field) => field.startsWith(`${key} `))?.slice(key.length + 1);
    return {
      path: value("worktree"), head: value("HEAD"), branch: value("branch") || null,
      bare: fields.includes("bare"), prunable: fields.some((field) => /^prunable(?: |$)/u.test(field)),
    };
  }).filter((entry) => entry.path);
}

let nulWorktreeOutput = true;
/** Older Git has no -z; retain its line protocol without shell path splitting. */
export function readWorktrees(path) {
  if (nulWorktreeOutput) {
    try { return parseWorktrees(readWorkspaceGit(path, ["worktree", "list", "--porcelain", "-z"])); }
    catch (error) {
      if (!/unknown (?:switch|option).*z/u.test(String(error.stderr))) throw error;
      nulWorktreeOutput = false;
    }
  }
  const output = readWorkspaceGit(path, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain"]);
  return output.trimEnd().split("\n\n").filter(Boolean).flatMap((record) => {
    const fields = record.split("\n");
    // The legacy protocol cannot safely represent arbitrary newline paths.
    if (!fields[0].startsWith("worktree ") || fields[0].startsWith('worktree "')
      || fields.slice(1).some((field) => !/^(?:HEAD |branch |detached$|bare$|locked(?: |$)|prunable(?: |$))/u.test(field))) {
      throw new Error("ambiguous legacy worktree path; use Git with NUL porcelain support");
    }
    return parseWorktrees(`${fields.join("\0")}\0\0`);
  });
}
