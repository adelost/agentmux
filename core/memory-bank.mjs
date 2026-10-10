// Nightly local commit of the private memory tree. It is the durability actor:
// notes that only live in the working tree are one bad write away from being
// lost. It commits memory/ paths only, never touches other staged work in the
// shared index and never pushes (Mattias 2026-08-04 refused automatic
// publishing of daily files without a secret review).

import { spawnSync } from "child_process";
import { join } from "path";
import { tryLockDir } from "./dir-lock.mjs";

const LOCK_STALE_MS = 10 * 60_000;

// Token shapes worth stopping a commit for. Only added lines are scanned, so a
// value already in history does not block every later night.
const SECRET_PATTERNS = [
  ["anthropic-key", /sk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/],
  ["github-token", /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}/],
  ["aws-access-key", /AKIA[0-9A-Z]{16}/],
  ["slack-token", /xox[abprs]-[0-9A-Za-z-]{10,}/],
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

function git(workspace, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, {
    cwd: workspace, encoding: "utf-8", maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_EDITOR: "true" },
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

const nulList = (text) => String(text || "").split("\0").filter(Boolean);

/** WHAT: Checks added diff lines for secret-shaped tokens. WHY: Keeps a pasted key out of history without blocking on old lines. */
export function scanAddedSecrets(diff) {
  const hits = [];
  let file = null;
  let line = 0;
  for (const row of String(diff).split("\n")) {
    if (row.startsWith("+++ ")) { file = row.replace(/^\+\+\+ (?:b\/)?/, ""); continue; }
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (row.startsWith("+")) {
      const found = SECRET_PATTERNS.find(([, pattern]) => pattern.test(row));
      if (found) hits.push({ file, line, kind: found[0] });
      line += 1;
    } else if (!row.startsWith("-")) {
      line += 1;
    }
  }
  return hits;
}

const isGitRepo = (workspace) => git(workspace, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true }).stdout.trim() === "true";

/** WHAT: Collects uncommitted memory paths. WHY: Keeps lint and the nightly run on the same durability backlog. */
export function pendingMemoryPaths(workspace) {
  if (!isGitRepo(workspace)) return null;
  const out = git(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "memory/"]).stdout;
  return nulList(out).filter((entry) => /^.. /.test(entry)).map((entry) => entry.slice(3));
}

/** WHAT: Saves pending memory changes as a local commit after a secret scan. WHY: Keeps notes durable every night without publishing them. */
export function bankMemory(workspace, { dryRun = false, message } = {}) {
  const pending = pendingMemoryPaths(workspace);
  if (pending === null) return { workspace, skipped: "not-a-git-repo", files: [] };
  if (!pending.length) return { workspace, banked: 0, files: [] };
  if (dryRun) return { workspace, dryRun: true, files: pending };

  const gitDir = git(workspace, ["rev-parse", "--absolute-git-dir"]).stdout.trim();
  const release = tryLockDir(join(gitDir, "amux-memory-bank.lock"), { staleMs: LOCK_STALE_MS });
  if (!release) return { workspace, skipped: "bank-already-running", files: pending };
  try {
    const before = new Set(nulList(git(workspace, ["diff", "--cached", "--name-only", "-z", "--", "memory/"]).stdout));
    git(workspace, ["add", "-A", "--", "memory/"]);
    const staged = nulList(git(workspace, ["diff", "--cached", "--name-only", "-z", "--", "memory/"]).stdout);
    const unstageOurs = () => {
      const ours = staged.filter((path) => !before.has(path));
      if (ours.length) git(workspace, ["reset", "-q", "--", ...ours], { allowFailure: true });
    };
    const hits = scanAddedSecrets(git(workspace, ["diff", "--cached", "-U0", "--no-color", "--no-ext-diff", "--", "memory/"]).stdout);
    if (hits.length) {
      unstageOurs();
      return { workspace, skipped: "secret-pattern", hits, files: staged };
    }
    if (!staged.length) return { workspace, banked: 0, files: [] };
    const subject = message || `chore(memory): bank ${staged.length} file(s)`;
    try {
      git(workspace, ["commit", "--only", "-q", "-m", subject, "--", "memory/"]);
    } catch (error) {
      unstageOurs();
      throw error;
    }
    const commit = git(workspace, ["rev-parse", "HEAD"]).stdout.trim();
    return { workspace, banked: staged.length, commit, files: staged };
  } finally {
    release();
  }
}

/** WHAT: Formats one bank run. WHY: Keeps the nightly log readable and never prints a matched secret. */
export function formatMemoryBank(result) {
  if (result.skipped === "secret-pattern") {
    const where = result.hits.map((hit) => `${hit.file}:${hit.line} (${hit.kind})`).join(", ");
    return `WARN memory bank skipped: secret-shaped text on added lines at ${where}. Remove it, then rerun amux memory bank.`;
  }
  if (result.skipped) return `Memory bank skipped: ${result.skipped}`;
  if (result.dryRun) return `Memory bank: would commit ${result.files.length} memory path(s), no push`;
  if (!result.banked) return "Memory bank: nothing to commit";
  return `Memory bank: committed ${result.banked} memory path(s) as ${result.commit.slice(0, 12)}, no push`;
}
