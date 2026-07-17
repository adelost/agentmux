import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { component, expect, feature, integration, unit } from "bdd-vitest";
import {
  assertMasterReleaseTarget,
  assertReleaseSha,
  stageReleaseArtifact,
} from "./release-install.mjs";
import { RELEASE_MANIFEST_NAME } from "./release-identity.mjs";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function repositoryFixture() {
  const base = mkdtempSync(join(tmpdir(), "amux-release-stage-"));
  const repo = join(base, "repo");
  mkdirSync(join(repo, "bin"), { recursive: true });
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.name", "Release Test"]);
  git(repo, ["config", "user.email", "release@example.invalid"]);
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({
    name: "agentmux", version: "9.8.7", type: "module",
    bin: { amux: "./bin/agent-cli.mjs" },
  })}\n`);
  writeFileSync(join(repo, "bin", "agent-cli.mjs"), "#!/usr/bin/env node\nconsole.log('committed');\n");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "fixture"]);
  const sha = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["update-ref", "refs/remotes/origin/master", sha]);
  writeFileSync(join(repo, "tracked.txt"), "dirty-worktree\n");
  writeFileSync(join(repo, "untracked.txt"), "owner-wip\n");
  return { base, repo, sha, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

feature("explicit-SHA release artifact", () => {
  unit("only a full commit SHA can authorize a release", {
    then: ["branch names and abbreviated hashes are rejected", () => {
      expect(() => assertReleaseSha("origin/master")).toThrow(/40-character/i);
      expect(() => assertReleaseSha(SHA_A.slice(0, 12))).toThrow(/40-character/i);
      expect(assertReleaseSha(SHA_A)).toBe(SHA_A);
    }],
  });

  unit("a stale explicit SHA cannot install behind origin/master", {
    then: ["the target must equal the fetched master revision", () => {
      expect(() => assertMasterReleaseTarget({ sourceSha: SHA_A, masterSha: SHA_B }))
        .toThrow(/origin\/master/i);
      expect(assertMasterReleaseTarget({ sourceSha: SHA_A, masterSha: SHA_A })).toBe(SHA_A);
    }],
  });

  integration("staging archives the commit and never consumes or mutates owner WIP", {
    given: ["a repository with committed code plus dirty and untracked owner work", () => repositoryFixture()],
    when: ["packing the exact master SHA", (ctx) => ({
      ctx,
      before: { head: git(ctx.repo, ["rev-parse", "HEAD"]), status: git(ctx.repo, ["status", "--porcelain"]) },
      staged: stageReleaseArtifact({
        repoRoot: ctx.repo,
        sourceSha: ctx.sha,
        outputRoot: join(ctx.base, "output"),
      }),
    })],
    then: ["the tarball carries committed bytes and a source receipt while WIP remains byte-exact", ({ ctx, before, staged }) => {
      const unpacked = join(ctx.base, "unpacked");
      mkdirSync(unpacked);
      execFileSync("tar", ["-xzf", staged.artifactPath, "-C", unpacked]);
      expect(readFileSync(join(unpacked, "package", "tracked.txt"), "utf8")).toBe("committed\n");
      expect(existsSync(join(unpacked, "package", "untracked.txt"))).toBe(false);
      const manifest = JSON.parse(readFileSync(
        join(unpacked, "package", RELEASE_MANIFEST_NAME), "utf8",
      ));
      expect(manifest).toMatchObject({ schemaVersion: 1, sourceSha: ctx.sha, packageVersion: "9.8.7" });
      expect(manifest.files["tracked.txt"]).toBe(
        createHash("sha256").update("committed\n").digest("hex"),
      );
      expect(staged.artifactSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(git(ctx.repo, ["rev-parse", "HEAD"])).toBe(before.head);
      expect(git(ctx.repo, ["status", "--porcelain"])).toBe(before.status);
      expect(readFileSync(join(ctx.repo, "tracked.txt"), "utf8")).toBe("dirty-worktree\n");
      expect(readFileSync(join(ctx.repo, "untracked.txt"), "utf8")).toBe("owner-wip\n");
      ctx.cleanup();
    }],
  });

  component("setup installs fetched master as an immutable artifact instead of npm-linking a checkout", {
    when: ["reading the setup contract", () => readFileSync(resolve("bin/setup.sh"), "utf8")],
    then: ["the explicit master SHA feeds the release installer and npm link is absent", (source) => {
      expect(source).toContain("refs/remotes/origin/master");
      expect(source).toContain("bin/install-release.mjs");
      expect(source).not.toMatch(/npm\s+link/u);
    }],
  });
});
