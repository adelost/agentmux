import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { component, expect, feature, integration, unit } from "bdd-vitest";
import {
  assertMasterReleaseTarget,
  assertReleaseSha,
  assertSnapshotRecoverable,
  restoreRuntimeConfig,
  snapshotRuntimeConfig,
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
  mkdirSync(join(repo, "nested"), { recursive: true });
  git(repo, ["init", "--quiet"]);
  git(repo, ["config", "user.name", "Release Test"]);
  git(repo, ["config", "user.email", "release@example.invalid"]);
  writeFileSync(join(repo, "package.json"), `${JSON.stringify({
    name: "agentmux", version: "9.8.7", type: "module",
    bin: { amux: "./bin/agent-cli.mjs" },
  })}\n`);
  writeFileSync(join(repo, "bin", "agent-cli.mjs"), "#!/usr/bin/env node\nconsole.log('committed');\n");
  writeFileSync(join(repo, "tracked.txt"), "committed\n");
  writeFileSync(join(repo, "nested", ".gitignore"), "*\n!.gitignore\n!keep.txt\n");
  writeFileSync(join(repo, "nested", "keep.txt"), "keep\n");
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
      const prefix = join(ctx.base, "npm-prefix");
      execFileSync("npm", [
        "install", "--global", "--prefix", prefix, "--ignore-scripts", staged.artifactPath,
      ]);
      const installed = join(prefix, "lib", "node_modules", "agentmux");
      expect(readFileSync(join(unpacked, "package", "tracked.txt"), "utf8")).toBe("committed\n");
      expect(existsSync(join(unpacked, "package", "untracked.txt"))).toBe(false);
      const manifest = JSON.parse(readFileSync(
        join(unpacked, "package", RELEASE_MANIFEST_NAME), "utf8",
      ));
      expect(manifest).toMatchObject({ schemaVersion: 1, sourceSha: ctx.sha, packageVersion: "9.8.7" });
      expect(manifest.files["tracked.txt"]).toBe(
        createHash("sha256").update("committed\n").digest("hex"),
      );
      expect(existsSync(join(unpacked, "package", "nested", ".gitignore"))).toBe(true);
      expect(existsSync(join(installed, "nested", ".npmignore"))).toBe(true);
      expect(manifest.files["nested/.npmignore"]).toBe(
        createHash("sha256").update("*\n!.gitignore\n!keep.txt\n").digest("hex"),
      );
      expect(manifest.files["nested/.gitignore"]).toBeUndefined();
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

  component("runtime config survives snapshot and restore with home precedence", {
    given: ["a home, repo, and installed package each holding divergent config", () => {
      const base = mkdtempSync(join(tmpdir(), "amux-release-config-"));
      const home = join(base, "home");
      const repo = join(base, "repo");
      const installed = join(base, "installed");
      mkdirSync(join(home, ".agentmux"), { recursive: true });
      mkdirSync(repo, { recursive: true });
      mkdirSync(installed, { recursive: true });
      writeFileSync(join(home, ".agentmux", ".env"), "home-env\n");
      writeFileSync(join(home, ".agentmux", "agentmux.yaml"), "home-yaml\n");
      writeFileSync(join(repo, ".env"), "repo-env\n");
      writeFileSync(join(repo, "agentmux.yaml"), "repo-yaml\n");
      writeFileSync(join(installed, ".env"), "installed-env\n");
      writeFileSync(join(installed, "agentmux.yaml"), "installed-yaml\n");
      return { base, home, repo, installed, cleanup: () => rmSync(base, { recursive: true, force: true }) };
    }],
    when: ["snapshotting then restoring into a fresh package", (ctx) => {
      const configs = snapshotRuntimeConfig(ctx.repo, ctx.installed, ctx.home);
      const fresh = join(ctx.base, "fresh-package");
      mkdirSync(fresh, { recursive: true });
      restoreRuntimeConfig(configs, fresh, ctx.home);
      return { ctx, configs, fresh };
    }],
    then: ["home bytes win and land in both the external home and the package fallback at 0600", ({ ctx, configs, fresh }) => {
      try {
        expect(assertSnapshotRecoverable(configs)).toBeUndefined();
        expect(configs.map((file) => file.name).sort()).toEqual([".env", "agentmux.yaml"]);
        const env = configs.find((file) => file.name === ".env");
        expect(String(env.bytes)).toBe("home-env\n");
        for (const target of [join(ctx.home, ".agentmux", ".env"), join(fresh, ".env")]) {
          expect(readFileSync(target, "utf8")).toBe("home-env\n");
          expect(statSync(target).mode & 0o777).toBe(0o600);
        }
        expect(readFileSync(join(fresh, "agentmux.yaml"), "utf8")).toBe("home-yaml\n");
        ctx.cleanup();
      } catch (error) { ctx.cleanup(); throw error; }
    }],
  });

  component("an unsnapshotable runtime config refuses the release before any mutation", {
    then: ["missing .env or agentmux.yaml is a classified refusal, both present passes", () => {
      expect(() => assertSnapshotRecoverable([])).toThrow(/unrecoverable release/);
      expect(() => assertSnapshotRecoverable([{ name: ".env", bytes: Buffer.from("x") }]))
        .toThrow(/agentmux\.yaml/);
      expect(() => assertSnapshotRecoverable([{ name: "agentmux.yaml", bytes: Buffer.from("x") }]))
        .toThrow(/\.env/);
      expect(assertSnapshotRecoverable([
        { name: ".env", bytes: Buffer.from("x") },
        { name: "agentmux.yaml", bytes: Buffer.from("y") },
      ])).toBeUndefined();
    }],
  });

  component("explicit env-pinned config paths are accepted as the recoverable source", {
    given: ["custom config files that exist ONLY outside home/repo/installed package", () => {
      const base = mkdtempSync(join(tmpdir(), "amux-release-envpin-"));
      const home = join(base, "home");
      const repo = join(base, "repo");
      const installed = join(base, "installed");
      const pinned = join(base, "pinned");
      mkdirSync(join(home, ".agentmux"), { recursive: true });
      mkdirSync(repo, { recursive: true });
      mkdirSync(installed, { recursive: true });
      mkdirSync(pinned, { recursive: true });
      writeFileSync(join(pinned, "secrets.env"), "pinned-env-bytes\n");
      writeFileSync(join(pinned, "fleet.yaml"), "pinned-yaml-bytes\n");
      const env = {
        AMUX_DISCORD_ENV: join(pinned, "secrets.env"),
        AGENTMUX_YAML: join(pinned, "fleet.yaml"),
      };
      return { base, home, repo, installed, env, cleanup: () => rmSync(base, { recursive: true, force: true }) };
    }],
    when: ["snapshotting and restoring with only env-pinned sources", (ctx) => {
      const configs = snapshotRuntimeConfig(ctx.repo, ctx.installed, ctx.home, ctx.env);
      const fresh = join(ctx.base, "fresh-package");
      mkdirSync(fresh, { recursive: true });
      restoreRuntimeConfig(configs, fresh, ctx.home);
      return { ctx, configs, fresh };
    }],
    then: ["the exact pinned bytes are recoverable and land byte-exact in home and package", ({ ctx, configs, fresh }) => {
      try {
        expect(assertSnapshotRecoverable(configs)).toBeUndefined();
        const env = configs.find((file) => file.name === ".env");
        const yaml = configs.find((file) => file.name === "agentmux.yaml");
        expect(String(env.bytes)).toBe("pinned-env-bytes\n");
        expect(String(yaml.bytes)).toBe("pinned-yaml-bytes\n");
        expect(readFileSync(join(ctx.home, ".agentmux", ".env"), "utf8")).toBe("pinned-env-bytes\n");
        expect(readFileSync(join(fresh, ".env"), "utf8")).toBe("pinned-env-bytes\n");
        expect(readFileSync(join(fresh, "agentmux.yaml"), "utf8")).toBe("pinned-yaml-bytes\n");
        ctx.cleanup();
      } catch (error) { ctx.cleanup(); throw error; }
    }],
  });
});
