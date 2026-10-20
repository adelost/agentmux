// Fixture world for the rules lint tests: a temporary home, bare remotes and clones with real history.
// Everything lives under one temporary directory, so no test touches the real home or a real repository.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SETTING_KEY = "cc-plugin-agents-md@builtin";
export const GOOD_SETTINGS = { pluginConfigs: { [SETTING_KEY]: { options: { instructionFiles: "claude-md-and-agents-md" } } } };

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Rules Lint Test", GIT_AUTHOR_EMAIL: "rules-lint@example.test",
  GIT_COMMITTER_NAME: "Rules Lint Test", GIT_COMMITTER_EMAIL: "rules-lint@example.test",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0",
};

/** Runs one git command in a fixture repository and returns trimmed stdout. */
export function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Builds a temporary home with the machine setting, one Claude profile and optional layer files. */
export function createWorld({ settings = GOOD_SETTINGS, layers = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "amux-rules-lint-"));
  const home = join(dir, "home");
  const profilesDir = join(home, ".config", "agent", "account-profiles");
  writeText(join(home, ".claude", "settings.json"), JSON.stringify(settings));
  mkdirSync(join(profilesDir, "claude", "p1"), { recursive: true });
  symlinkSync(join(home, ".claude", "settings.json"), join(profilesDir, "claude", "p1", "settings.json"));
  for (const [rel, text] of Object.entries(layers)) writeText(join(home, rel), text);
  return { dir, home, profilesDir };
}

export function removeWorld(world) {
  rmSync(world.dir, { recursive: true, force: true });
}

/** Creates an empty repository, with a bare origin unless remote is false. */
export function createRepo(world, name, { branch = "main", remote = true } = {}) {
  const root = join(world.dir, "work", name);
  mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", branch);
  git(root, "config", "user.name", "Rules Lint Test");
  git(root, "config", "user.email", "rules-lint@example.test");
  let bare = null;
  if (remote) {
    bare = join(world.dir, "remotes", `${name}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", branch);
    git(root, "remote", "add", "origin", bare);
  }
  return { root, bare, name };
}

/**
 * Writes files (text, { link } for a symlink, null to delete), stages exactly those paths and commits.
 * Returns the new commit sha.
 */
export function commit(repo, files, message) {
  for (const [rel, value] of Object.entries(files)) {
    const path = join(repo.root, rel);
    rmSync(path, { force: true });
    if (value === null) continue;
    if (value && typeof value === "object" && value.link) {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(value.link, path);
    } else {
      writeText(path, value);
    }
  }
  git(repo.root, "add", "--", ...Object.keys(files));
  git(repo.root, "commit", "-q", "-m", message);
  return git(repo.root, "rev-parse", "HEAD");
}

export function push(repo, branch = "main") {
  git(repo.root, "push", "-q", "origin", branch);
}

/** Runs git fetch so the clone has a FETCH_HEAD, as a pane's clone has after a pull. */
export function fetchOrigin(repo) {
  git(repo.root, "fetch", "-q", "origin");
}

export function setOriginHead(repo, branch) {
  git(repo.root, "remote", "set-head", "origin", branch);
}
