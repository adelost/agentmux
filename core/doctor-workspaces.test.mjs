import { afterEach, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverGitRoots, parseWorktrees, readWorkspaceGit } from "./git-workspaces.mjs";
import { checkWorkspaceHealth, observeWorkspaceHealth } from "./doctor-workspaces.mjs";

const temporary = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(branch = "main") {
  const base = mkdtempSync(join(tmpdir(), "amux-workspaces-"));
  temporary.push(base);
  const root = join(base, "canonical med åäö");
  mkdirSync(root);
  const git = (args, path = root) => execFileSync("git", ["-C", path, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" },
  }).trim();
  git(["init", "-b", branch]);
  writeFileSync(join(root, "tracked"), "initial\n");
  git(["add", "tracked"]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "-m", "initial"]);
  git(["update-ref", `refs/remotes/origin/${branch}`, "HEAD"]);
  git(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`]);
  return { base, root, git, agents: [{ dir: root }] };
}

test("normal clean feature worktree may lag trunk without a warning; index and refs remain unchanged", () => {
  const { root, base, git } = fixture();
  const feature = join(base, "feature");
  git(["worktree", "add", "-b", "feature/test", feature]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "trunk advance"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const index = join(root, ".git", "index");
  const before = { bytes: readFileSync(index), mtimeMs: statSync(index).mtimeMs, refs: git(["show-ref"]) };
  const observation = observeWorkspaceHealth([{ dir: root }, { dir: feature }]);
  expect(observation.repositories).toHaveLength(1);
  expect(checkWorkspaceHealth(observation).every((row) => row.status === "ok")).toBe(true);
  expect(readFileSync(index)).toEqual(before.bytes);
  expect(statSync(index).mtimeMs).toBe(before.mtimeMs);
  expect(git(["show-ref"])).toBe(before.refs);
});

test("duplicate trunk is red and identifies both exact paths, including a custom default branch", () => {
  const { base, root, git, agents } = fixture("trunk");
  const duplicate = join(base, "second trunk");
  git(["worktree", "add", "--force", duplicate, "trunk"]);
  const rows = checkWorkspaceHealth(observeWorkspaceHealth(agents));
  expect(rows.find((row) => row.name === "workspace trunk")).toMatchObject({ status: "fail" });
  expect(rows[0].detail).toContain(root);
  expect(rows[0].detail).toContain(duplicate);
});

test("canonical drift counts commits while preserving the dirty file and branch", () => {
  const { root, git, agents } = fixture();
  git(["switch", "-c", "feature/active"]);
  writeFileSync(join(root, "tracked"), "operator WIP\n");
  const next = git(["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "remote advance"]);
  git(["update-ref", "refs/remotes/origin/main", next]);
  const rows = checkWorkspaceHealth(observeWorkspaceHealth(agents));
  expect(rows.find((row) => row.name === "workspace canonical").detail)
    .toContain("feature/active; expected main; 0 ahead / 1 behind origin/main (local snapshot)");
  expect(readFileSync(join(root, "tracked"), "utf8")).toBe("operator WIP\n");
  expect(git(["branch", "--show-current"])).toBe("feature/active");
});

test("same-branch stale canonical is diagnosed without requiring a feature checkout", () => {
  const { git, agents } = fixture();
  const next = git(["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "remote advance"]);
  git(["update-ref", "refs/remotes/origin/main", next]);
  expect(checkWorkspaceHealth(observeWorkspaceHealth(agents))[0].detail)
    .toContain("main; expected main; 0 ahead / 1 behind origin/main");
});

test.each(["CHERRY_PICK_HEAD", "MERGE_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"])(
  "old %s operation uses linked worktree metadata; fresh operation is informational", (marker) => {
    const { base, git, agents } = fixture();
    const feature = join(base, "active");
    git(["worktree", "add", "-b", "feature/operation", feature]);
    const markerPath = git(["rev-parse", "--path-format=absolute", "--git-path", marker], feature);
    if (marker.endsWith("HEAD")) writeFileSync(markerPath, `${git(["rev-parse", "HEAD"])}\n`);
    else mkdirSync(markerPath);
    const fresh = checkWorkspaceHealth(observeWorkspaceHealth(agents));
    expect(fresh.find((row) => row.name === "workspace operation").status).toBe("ok");
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    utimesSync(markerPath, old, old);
    const markerMtime = statSync(markerPath).mtimeMs;
    const row = checkWorkspaceHealth(observeWorkspaceHealth(agents)).find((item) => item.name === "workspace operation");
    expect(row.status).toBe("warn");
    expect(row.detail).toContain(feature);
    expect(row.detail).toContain("marker age 72h");
    expect(row.detail).toContain(markerPath);
    expect(statSync(markerPath).mtimeMs).toBe(markerMtime);
  },
);

test("discovery is shared, covers umbrella directories and declares exhausted budgets", () => {
  const { base, root, agents } = fixture();
  expect([...discoverGitRoots([base])]).toContain(root);
  const observation = observeWorkspaceHealth(agents, { budgetMs: 0 });
  expect(checkWorkspaceHealth(observation)[0]).toMatchObject({ status: "warn" });
  expect(observation.issues.join()).toContain("remaining repositories not checked");
  const issues = [];
  discoverGitRoots([base], { maxEntries: 1, onIssue: (issue) => issues.push(issue) });
  expect(issues.join()).toContain("discovery limited");
});

test("NUL porcelain preserves paths instead of interpreting Git quoting", () => {
  const path = '/repo/a "quoted"\nfeature';
  expect(parseWorktrees(`worktree ${path}\0HEAD abc\0branch refs/heads/topic\0\0`))
    .toEqual([{ path, head: "abc", branch: "refs/heads/topic", bare: false, prunable: false }]);
});

test("no default HEAD falls back only to an unambiguous local remote-tracking branch", () => {
  const { git, agents } = fixture();
  git(["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"]);
  expect(checkWorkspaceHealth(observeWorkspaceHealth(agents))[0].status).toBe("ok");
  git(["update-ref", "refs/remotes/origin/master", "HEAD"]);
  expect(checkWorkspaceHealth(observeWorkspaceHealth(agents))[0].detail).toContain("remote default branch unknown");
});

test("Git failures are visible; broken repositories never become a green zero", () => {
  const { root, agents } = fixture();
  writeFileSync(join(root, ".git", "HEAD"), "broken HEAD\n");
  expect(checkWorkspaceHealth(observeWorkspaceHealth(agents))[0]).toMatchObject({ name: "workspace scan", status: "warn" });
  expect(() => readWorkspaceGit(root, ["rev-parse", "HEAD"])).toThrow();
});

test("doctor --workspaces routes to the inventory without touching tmux or network probes", () => {
  const { base, root } = fixture();
  const configPath = join(base, "agents.yaml");
  writeFileSync(configPath, `fixture:\n  dir: ${JSON.stringify(root)}\n`);
  const commandsUrl = new URL("../cli/commands.mjs", import.meta.url).href;
  const script = `import {dispatch} from ${JSON.stringify(commandsUrl)};
    globalThis.fetch = () => { throw new Error("unexpected network probe"); };
    await dispatch(["doctor", "--workspaces"], {
      configPath: process.argv[1], tmux: () => { throw new Error("unexpected tmux probe"); }
    });`;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, configPath], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 5_000,
  });
  expect(output).toContain("1 repositories checked");
  expect(output).not.toContain("bridge process");
});

test("a missing configured workspace is a visible coverage gap", () => {
  const { base } = fixture();
  const rows = checkWorkspaceHealth(observeWorkspaceHealth([{ dir: join(base, "missing") }]));
  expect(rows[0]).toMatchObject({ name: "workspace scan", status: "warn" });
  expect(rows[0].detail).toContain("configured workspace missing");
});
