// WHAT: Prepares ordinary Markdown in a fixed private Git worktree.
// WHY: Curator edits stay inspectable and separate from the live memory and original digest evidence.
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertDreamWritePath, readDreamRegular } from "./dream-memory-effects.mjs";
import { lintMemory } from "./memory-lint.mjs";
import { scanAddedSecrets } from "./memory-bank.mjs";
import { writeDreamAtomic } from "./dream-commit.mjs";

/** WHAT: Returns the checksum of exact care bytes. WHY: Keeps published content bound to its frozen source. */
export const careHash = bytes => createHash("sha256").update(bytes).digest("hex");
const put = (path, bytes) => { assertDreamWritePath(path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 }); };
const git = (cwd, args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } });
  if (result.status !== 0) throw Error(`dream-care-git:${args[0]}:${result.stderr.trim()}`);
  return result.stdout;
};
const warningKeys = result => result.findings.filter(row => row.severity === "warning").map(row => JSON.stringify([row.code, row.file, row.message])).sort();

/** WHAT: Builds one bounded source revision for the next curator turn. WHY: Prevents an unbanked draft from being reset or mistaken for fresh source. */
export function prepareDreamCare(workspace, config) {
  const root = config.root, repo = join(root, "repo"), worktree = join(root, "worktree"), outbox = join(root, "outbox");
  for (const dir of [repo, outbox, join(root, "controller")]) { assertDreamWritePath(join(dir, "placeholder")); mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  const sources = ["MEMORY.md", config.reference || "memory/references/memory-flow.md"];
  if (!/^memory\/references\/[a-z0-9-]+\.md$/u.test(sources[1])) throw Error("dream-care-reference-invalid");
  if (!existsSync(join(repo, ".git"))) {
    git(repo, ["init", "-q", "--initial-branch=intake"]);
    git(repo, ["config", "user.name", "AMUX memory care"]); git(repo, ["config", "user.email", "memory-care@localhost"]);
    git(repo, ["commit", "-q", "--allow-empty", "-m", "Private memory care; no remote"]);
    git(repo, ["worktree", "add", "-q", "-b", "care", worktree]);
  }
  if (git(worktree, ["status", "--porcelain", "--untracked-files=all"]).trim()) throw Error("dream-care-unbanked-draft: preserve and inspect the previous turn");
  // Only this private, already banked worktree is refreshed. No shared source path is written.
  for (const path of git(worktree, ["ls-files", "-z"]).split("\0").filter(Boolean)) { assertDreamWritePath(join(worktree, path)); unlinkSync(join(worktree, path)); }
  const sourceHashes = {};
  for (const path of sources) {
    assertDreamWritePath(join(workspace, path));
    const bytes = readDreamRegular(join(workspace, path), 128 * 1024);
    sourceHashes[path] = careHash(bytes); put(join(worktree, path), bytes);
  }
  git(worktree, ["add", "--", "MEMORY.md", "memory/references"]);
  git(worktree, ["commit", "-q", "--allow-empty", "-m", "Read-only source baseline for ordinary care"]);
  const runId = randomUUID();
  return { version: 1, root, worktree, sourceHashes, sourceReference: sources[1], baseCommit: git(worktree, ["rev-parse", "HEAD"]).trim(),
    runId, modelOutputPath: join(outbox, `${runId}.summary.md`), baselineWarnings: warningKeys(lintMemory(worktree, { home: join(root, "empty-home") })) };
}

/** WHAT: Stores the completed Markdown diff independently of digest acceptance. WHY: Keeps a care refusal from discarding a valid digest or inspectable draft. */
export function freezeDreamCare(input) {
  const path = input.path.replace(/\.json$/u, ".care.json");
  if (existsSync(path)) {
    const receipt = JSON.parse(readDreamRegular(path, 512 * 1024));
    if (receipt.sourceSha256 !== input.sha256) throw Error("dream-care-receipt-source-mismatch");
    return receipt;
  }
  const document = JSON.parse(readDreamRegular(input.path, 256 * 1024)), care = document.memoryCare;
  let receipt = { version: 1, sourceSha256: input.sha256, state: "refused", reason: care?.preparationError || "care-not-configured" };
  try {
    if (!care?.baseCommit) throw Error(receipt.reason);
    if (git(care.worktree, ["rev-parse", "HEAD"]).trim() !== care.baseCommit) throw Error("dream-care-draft-base-changed");
    const files = git(care.worktree, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
    const tracked = git(care.worktree, ["diff", "--name-only", care.baseCommit]).trim().split("\n").filter(Boolean);
    const changed = [...new Set([...files, ...tracked])];
    if (changed.some(file => file !== "MEMORY.md" && !/^memory\/references\/care-[a-z0-9-]+\.md$/u.test(file)) || changed.length > 4) throw Error("dream-care-outside-publication-scope");
    const before = git(care.worktree, ["show", `${care.baseCommit}:MEMORY.md`]);
    const after = readDreamRegular(join(care.worktree, "MEMORY.md"), 16 * 1024).toString("utf8");
    if (!after.startsWith(before)) throw Error("dream-care-index-replacement-refused");
    const suffix = after.slice(before.length);
    if (!suffix.trim() || Buffer.byteLength(suffix) > 1024 || /<!--\s*\/?amux-/iu.test(suffix)) throw Error("dream-care-index-suffix-invalid");
    const existing = new Set(git(care.worktree, ["ls-tree", "-r", "--name-only", care.baseCommit]).trim().split("\n"));
    const references = changed.filter(file => file !== "MEMORY.md").map(file => {
      if (existing.has(file)) throw Error("dream-care-existing-reference-refused");
      assertDreamWritePath(join(care.worktree, file));
      const content = readDreamRegular(join(care.worktree, file), 32 * 1024).toString("utf8");
      if (!suffix.includes(file)) throw Error("dream-care-reference-not-indexed");
      return { path: file, content, sha256: careHash(content) };
    });
    if (!references.length) throw Error("dream-care-no-reference");
    const baseline = new Set(care.baselineWarnings);
    if (warningKeys(lintMemory(care.worktree, { home: join(care.root, "empty-home") })).some(key => !baseline.has(key))) throw Error("dream-care-new-lint-warning");
    git(care.worktree, ["add", "--", ...changed]);
    const diff = git(care.worktree, ["diff", "--cached", care.baseCommit]);
    if (scanAddedSecrets(diff).length) throw Error("dream-care-secret-shaped-addition");
    git(care.worktree, ["commit", "-q", "-m", "Native curator file care; private draft"]);
    receipt = { version: 1, sourceSha256: input.sha256, state: "ready", baseCommit: care.baseCommit,
      draftCommit: git(care.worktree, ["rev-parse", "HEAD"]).trim(), diffSha256: careHash(diff), sourceHashes: care.sourceHashes, indexBefore: before, suffix, references, applied: [] };
    writeDreamAtomic(input.path.replace(/\.json$/u, ".care.diff"), diff, { immutable: true });
  } catch (error) { receipt.reason = error.message; }
  writeDreamAtomic(path, JSON.stringify(receipt) + "\n", { immutable: true });
  return receipt;
}
