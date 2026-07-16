import { execFileSync } from "node:child_process";
import {
  mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const cleanupPaths = [];
const script = resolve("bin/overlap-gate.mjs");

const gitRaw = (cwd, ...args) => execFileSync(
  "git",
  ["-C", cwd, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

const git = (cwd, ...args) => gitRaw(cwd, ...args).trim();

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "amux-overlap-gate-"));
  const worktree = `${root}-feature`;
  cleanupPaths.push(worktree, root);
  git(root, "init", "-b", "master");
  git(root, "config", "user.email", "gate@example.invalid");
  git(root, "config", "user.name", "Gate Fixture");
  mkdirSync(join(root, "src", "game"), { recursive: true });
  writeFileSync(join(root, "src", "game", "vehicles.js"), "export const speed = 1;\n");
  git(root, "add", ".");
  git(root, "commit", "-m", "base");
  git(root, "update-ref", "refs/remotes/origin/master", "HEAD");
  git(root, "worktree", "add", "-b", "feature", worktree, "master");
  return { root, worktree };
};

const scan = (root) => JSON.parse(execFileSync(
  process.execPath,
  [script, "scan", root, "--json"],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
));

afterEach(() => {
  for (const path of cleanupPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("overlap-gate status protocol", () => {
  it("preserves the first character of an unstaged path that the legacy parser corrupts", () => {
    const { root, worktree } = fixture();
    writeFileSync(
      join(worktree, "src", "game", "vehicles.js"),
      "export const speed = 2;\n",
    );

    const porcelain = gitRaw(
      worktree,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    );
    expect(porcelain).toBe(" M src/game/vehicles.js\n");

    // Negative control: this is the exact trim + slice protocol from the
    // former host-local script. It must reproduce the reported defect.
    const legacyPath = porcelain.trim().split("\n")[0].slice(3);
    expect(legacyPath).toBe("rc/game/vehicles.js");

    const result = scan(root);
    const feature = result.worktrees.find(({ path }) => path === worktree);
    expect(feature.files).toContain("src/game/vehicles.js");
    expect(feature.files).not.toContain("rc/game/vehicles.js");
  });

  it("uses the live destination path for renames in NUL-delimited output", () => {
    const { root, worktree } = fixture();
    const oldPath = join(worktree, "src", "game", "vehicles.js");
    const newPath = join(worktree, "src", "game", "race-vehicles.js");
    renameSync(oldPath, newPath);
    git(worktree, "add", "-A");

    const result = scan(root);
    const feature = result.worktrees.find(({ path }) => path === worktree);
    expect(feature.files).toContain("src/game/race-vehicles.js");
    expect(feature.files).not.toContain("src/game/vehicles.js");
  });
});
