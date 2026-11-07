/** WHAT: Publishes generated task ledgers through isolated Git objects. WHY: Keeps shared workfiles and staged edits outside concurrent ledger writes. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

function git(repo, args, options = {}) {
  const { raw, ...runOptions } = options;
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
    ...runOptions, env: { ...env, ...options.env },
  });
  if (result.status !== 0) throw new Error(`${args[0]}: ${result.stderr?.trim() || result.error?.message || "failed"}`);
  return raw ? result.stdout : result.stdout.trimEnd();
}

/** WHAT: Collects staged, unstaged and untracked task ledgers. WHY: Prevents lint from accepting rows that never reached the remote board. */
export function dirtyLedgers(repo) {
  try {
    const directory = statSync(repo).isFile() ? dirname(repo) : repo;
    const root = git(directory, ["rev-parse", "--show-toplevel"]);
    const paths = [":(glob)**/TASKS*.md", "TASKS.md"];
    return [...new Set([
      ...git(root, ["diff", "--name-only", "-z", "HEAD", "--", ...paths]).split("\0"),
      ...git(root, ["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths]).split("\0"),
    ].filter(Boolean))].map(path => resolve(root, path));
  } catch (error) {
    if (/not a git repository/.test(error.message)) return [];
    throw error;
  }
}

/** WHAT: Reports a ledger failure to the existing lead channel. WHY: Keeps a stopped mirror visible without another watcher or retry loop. */
export function ledgerAlarm(message) {
  const result = spawnSync("amux", ["sandman", "-p", "0", "--stdin"], {
    input: `Ledger STOP: ${message.replace(/\s+/g, " ")}\n`, encoding: "utf8", timeout: 30_000,
  });
  if (result.status !== 0) console.error(`ledger alarm delivery unconfirmed; do not resend automatically: ${result.stderr || result.error?.message}`);
  return result.status === 0;
}

/** WHAT: Fetches a shared mirror through fast-forward only. WHY: Preserves local edits and reports the blocking filenames instead of merging them. */
export function updateLedgerMirror(repo, branch, { alarm = ledgerAlarm } = {}) {
  try {
    const dirty = dirtyLedgers(repo);
    if (dirty.length) throw new Error(`uncommitted ledger: ${dirty.join(", ")}; use push_ledger.sh`);
    const current = git(repo, ["symbolic-ref", "--short", "HEAD"]);
    if (current !== branch) throw new Error(`mirror is on ${current}, expected ${branch}`);
    git(repo, ["fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    const common = resolve(repo, git(repo, ["rev-parse", "--git-common-dir"]));
    const merge = spawnSync("flock", ["-w", "30", join(common, "ledger-mirror.lock"),
      "git", "-C", repo, "merge", "--ff-only", `refs/remotes/origin/${branch}`], { encoding: "utf8", timeout: 35_000 });
    if (merge.status !== 0) throw new Error(merge.stderr || merge.error?.message || "mirror lock unavailable");
    return { ok: true, head: git(repo, ["rev-parse", "HEAD"]) };
  } catch (error) {
    alarm(`${resolve(repo)} mirror not updated: ${error.message}`);
    return { ok: false, error: error.message };
  }
}

function checkedLedger(previous, next) {
  if (!next.trim() || !next.includes("|")) throw new Error("generator returned an empty or non-table ledger");
  const oldLines = previous.split("\n").length;
  if (next.split("\n").length < oldLines - 2) throw new Error("generator shrank ledger by more than two lines; archive separately");
  return next;
}

/** WHAT: Builds a generator commit above origin and retries rejected pushes. WHY: Keeps concurrent writers from replacing each other's rows or touching the shared index. */
export function publishLedger({ repo, path, branch, subject, command, alarm = ledgerAlarm }) {
  if (!path || path.startsWith("/") || path.split("/").includes("..") || !/(^|\/)TASKS[^/]*\.md$/.test(path)) {
    throw new Error("--path must name a repository-relative TASKS markdown file");
  }
  if (!subject || !command?.length) throw new Error("subject and generator command required");
  branch ||= git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
  const ref = `refs/remotes/origin/${branch}`;
  const scratch = mkdtempSync(join(tmpdir(), "amux-ledger-"));
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      git(repo, ["fetch", "origin", `+refs/heads/${branch}:${ref}`]);
      const base = git(repo, ["rev-parse", ref]);
      const previous = git(repo, ["show", `${base}:${path}`], { raw: true });
      const generated = spawnSync(command[0], command.slice(1), {
        cwd: repo, input: previous, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, AMUX_LEDGER_BASE: base, AMUX_LEDGER_PATH: path },
      });
      if (generated.status !== 0) throw new Error(`generator failed: ${generated.stderr || generated.error?.message}`);
      const next = checkedLedger(previous, generated.stdout);
      // Legacy generators read origin/master themselves; ref movement invalidates that snapshot.
      if (git(repo, ["rev-parse", ref]) !== base) continue;
      if (next === previous) return { published: false, ...updateLedgerMirror(repo, branch, { alarm }) };
      const blob = git(repo, ["hash-object", "-w", "--stdin"], { input: next });
      const env = { GIT_INDEX_FILE: join(scratch, `index-${attempt}`) };
      git(repo, ["read-tree", base], { env });
      git(repo, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      const tree = git(repo, ["write-tree"], { env });
      const sha = git(repo, ["commit-tree", tree, "-p", base], { input: `${subject}\n` });
      let pushError;
      try { git(repo, ["push", "origin", `${sha}:refs/heads/${branch}`]); }
      catch (error) { pushError = error; }
      // A lost push response is resolved from remote ancestry before another write is allowed.
      git(repo, ["fetch", "origin", `+refs/heads/${branch}:${ref}`]);
      const remote = git(repo, ["rev-parse", ref]);
      const reached = spawnSync("git", ["-C", repo, "merge-base", "--is-ancestor", sha, remote]);
      if (reached.status === 0) return { published: true, sha, ...updateLedgerMirror(repo, branch, { alarm }) };
      const rejected = pushError && (/\[rejected\].*(?:fetch first|non-fast-forward)/.test(pushError.message)
        || /cannot lock ref .*is at .*but expected/.test(pushError.message));
      if (reached.status !== 1 || !rejected || remote === base) {
        throw pushError || new Error("push outcome could not be confirmed; inspect remote before retrying");
      }
    }
    throw new Error("ledger push rejected four times; nothing confirmed published");
  } catch (error) {
    alarm(`${resolve(repo)}/${path}: ${error.message}`);
    throw error;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}
