import { feature, unit, expect } from "bdd-vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { mkdtempSync } from "fs";
import {
  discoverDependencyRoots,
  nodeTreeIsRelocatable,
  nodeTreeMatches,
  provisionNodeRoot,
  provisionPythonRoot,
  provisionWorktreeDependencies,
  runScopedGate,
  runWorktreeCommand,
  selectScopedGate,
} from "./worktree-deps.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-worktree-deps-"));
  const commonDir = join(root, ".git");
  mkdirSync(commonDir);
  return { root, commonDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function packageLock(version = "4.0.18", extra = {}) {
  return {
    name: "fixture",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "fixture", devDependencies: { vitest: version } },
      "node_modules/vitest": {
        version,
        resolved: `https://registry.example/vitest-${version}.tgz`,
        integrity: `sha512-${version}`,
        ...extra,
      },
    },
  };
}

function writeNodeRoot(root, { lock = packageLock(), pkg = { name: "fixture", private: true } } = {}) {
  writeFileSync(join(root, "package.json"), `${JSON.stringify(pkg)}\n`);
  writeFileSync(join(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);
}

function writeInstalledTree(root, lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"))) {
  const modules = join(root, "node_modules");
  mkdirSync(join(modules, "vitest"), { recursive: true });
  const packages = Object.fromEntries(Object.entries(lock.packages).filter(([key]) => key));
  writeFileSync(join(modules, ".package-lock.json"), `${JSON.stringify({ lockfileVersion: 3, packages })}\n`);
}

feature("worktree dependency bootstrap", () => {
  unit("discovers every tracked npm/uv root and reports uncovered manifests", {
    given: ["a monorepo file ledger", () => [
      "package.json", "package-lock.json",
      "ui/package.json", "ui/package-lock.json",
      "python/pyproject.toml", "python/uv.lock",
      "orphan/package.json",
    ]],
    when: ["discovering dependency roots", (files) => discoverDependencyRoots("/repo", files)],
    then: ["root, nested UI, Python and the unsafe orphan are explicit", (result) => {
      expect(result.node.map((item) => item.root)).toEqual(["/repo", "/repo/ui"]);
      expect(result.python.map((item) => item.root)).toEqual(["/repo/python"]);
      expect(result.unsupported).toEqual([{
        ecosystem: "node",
        root: "/repo/orphan",
        reason: "tracked package.json has no covering package-lock.json",
      }]);
    }],
  });

  unit("promotes an exact npm tree to an immutable lock-keyed cache and links the worktree", {
    given: ["an exact local install", () => {
      const ctx = fixture();
      writeNodeRoot(ctx.root);
      writeInstalledTree(ctx.root);
      return ctx;
    }],
    when: ["provisioning twice", (ctx) => ({
      before: provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root, commonDir: ctx.commonDir, check: true, npmVersion: "11.6.0" }),
      first: provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root, commonDir: ctx.commonDir, npmVersion: "11.6.0" }),
      second: provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root, commonDir: ctx.commonDir, check: true, npmVersion: "11.6.0" }),
      ctx,
    })],
    then: ["the exact local tree passes check before becoming an immutable reusable link", ({ before, first, second, ctx }) => {
      expect(before).toMatchObject({ status: "ready", mode: "local-exact" });
      expect(first).toMatchObject({ status: "ready", mode: "immutable-link" });
      expect(second).toMatchObject({ status: "ready", mode: "immutable-link", key: first.key });
      expect(lstatSync(join(ctx.root, "node_modules")).isSymbolicLink()).toBe(false);
      const target = resolve(ctx.root, "node_modules", readlinkSync(join(ctx.root, "node_modules", "vitest")));
      expect(target).toContain(join(".git", "agentmux-worktree-deps", "node", first.key));
      expect(nodeTreeMatches(ctx.root)).toBe(true);
      ctx.cleanup();
    }],
  });

  unit("a changed lock never reuses the previous compiler cache", {
    given: ["a worktree linked for Vitest 4.0.18", () => {
      const ctx = fixture();
      writeNodeRoot(ctx.root);
      writeInstalledTree(ctx.root);
      const first = provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root, commonDir: ctx.commonDir, npmVersion: "11.6.0" });
      const next = packageLock("4.1.0");
      writeFileSync(join(ctx.root, "package-lock.json"), `${JSON.stringify(next)}\n`);
      return { ...ctx, first, next };
    }],
    when: ["reprovisioning with a fake deterministic npm ci", (ctx) => {
      const run = (command, args) => {
        expect(command).toBe("npm");
        if (args[0] === "--version") return { status: 0, stdout: "11.6.0\n", stderr: "" };
        writeInstalledTree(ctx.root, ctx.next);
        return { status: 0, stdout: "", stderr: "" };
      };
      return { ...ctx, second: provisionNodeRoot({
        root: ctx.root, repoRoot: ctx.root, commonDir: ctx.commonDir, run,
      }) };
    }],
    then: ["the target and key change while the old cache remains immutable", (ctx) => {
      expect(ctx.second.key).not.toBe(ctx.first.key);
      expect(readlinkSync(join(ctx.root, "node_modules", "vitest"))).toContain(ctx.second.key);
      expect(existsSync(join(ctx.commonDir, "agentmux-worktree-deps", "node", ctx.first.key))).toBe(true);
      expect(nodeTreeMatches(ctx.root)).toBe(true);
      ctx.cleanup();
    }],
  });

  unit("workspace links stay checkout-local instead of being relocated", {
    given: ["an npm workspace tree", () => {
      const ctx = fixture();
      const lock = packageLock("1.0.0", { link: true, resolved: "file:packages/vitest" });
      writeNodeRoot(ctx.root, { lock, pkg: { name: "fixture", workspaces: ["packages/*"] } });
      writeInstalledTree(ctx.root, lock);
      return ctx;
    }],
    when: ["provisioning", (ctx) => ({
      relocatable: nodeTreeIsRelocatable(ctx.root),
      result: provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root, commonDir: ctx.commonDir, npmVersion: "11.6.0" }),
      ctx,
    })],
    then: ["the real local node_modules is retained", ({ relocatable, result, ctx }) => {
      expect(relocatable).toBe(false);
      expect(result).toMatchObject({ status: "ready", mode: "local-workspace" });
      expect(lstatSync(join(ctx.root, "node_modules")).isSymbolicLink()).toBe(false);
      ctx.cleanup();
    }],
  });

  unit("a shared Python venv is replaced by a local locked environment", {
    given: ["a worktree with an unsafe venv symlink", () => {
      const ctx = fixture();
      writeFileSync(join(ctx.root, "pyproject.toml"), "[project]\nname='fixture'\nversion='1'\n");
      writeFileSync(join(ctx.root, "uv.lock"), "version = 1\n");
      const foreign = join(ctx.root, "foreign-venv");
      mkdirSync(join(foreign, "bin"), { recursive: true });
      symlinkSync(foreign, join(ctx.root, ".venv"), "dir");
      return ctx;
    }],
    when: ["running a locked sync", (ctx) => {
      const calls = [];
      const run = (command, args) => {
        calls.push([command, args]);
        if (args[0] === "sync" && !args.includes("--check")) {
          mkdirSync(join(ctx.root, ".venv", "bin"), { recursive: true });
          writeFileSync(join(ctx.root, ".venv", "bin", "python"), "");
        }
        return { status: 0, stdout: "", stderr: "" };
      };
      return { ctx, calls, result: provisionPythonRoot({ root: ctx.root, repoRoot: ctx.root, run }) };
    }],
    then: ["only a real local venv survives and uv.lock is unchanged", ({ ctx, calls, result }) => {
      expect(result).toMatchObject({ status: "ready", mode: "local-venv" });
      expect(lstatSync(join(ctx.root, ".venv")).isSymbolicLink()).toBe(false);
      expect(calls).toContainEqual(["uv", ["sync", "--locked"]]);
      expect(readFileSync(join(ctx.root, "uv.lock"), "utf8")).toBe("version = 1\n");
      expect(existsSync(join(ctx.root, ".venv", ".agentmux-worktree-deps.json"))).toBe(true);
      ctx.cleanup();
    }],
  });

  unit("locked Python drift is surfaced as skipped instead of editing the lock", {
    given: ["a uv project whose sync fails the locked contract", () => {
      const ctx = fixture();
      writeFileSync(join(ctx.root, "pyproject.toml"), "[project]\nname='fixture'\nversion='1'\n");
      writeFileSync(join(ctx.root, "uv.lock"), "version = 1\n");
      return ctx;
    }],
    when: ["provisioning the whole worktree", (ctx) => ({
      ctx,
      result: provisionWorktreeDependencies({
        context: { repoRoot: ctx.root, commonDir: ctx.commonDir, trackedFiles: ["pyproject.toml", "uv.lock"] },
        run: (_command, args) => ({ status: args[0] === "--version" ? 0 : 2, stdout: "", stderr: "locked drift" }),
      }),
    })],
    then: ["the result is non-green and names the skipped root", ({ ctx, result }) => {
      expect(result.ok).toBe(false);
      expect(result.skipped).toEqual([{
        ecosystem: "python",
        root: ctx.root,
        reason: `uv sync --locked failed in ${ctx.root}`,
      }]);
      expect(readFileSync(join(ctx.root, "uv.lock"), "utf8")).toBe("version = 1\n");
      ctx.cleanup();
    }],
  });

  unit("full gate discovery prefers the repository's blessed wrapper", {
    given: ["a repo with wrapper, Makefile and npm test", () => {
      const ctx = fixture();
      mkdirSync(join(ctx.root, "tools"));
      writeFileSync(join(ctx.root, "tools", "gate.sh"), "#!/bin/sh\n");
      writeFileSync(join(ctx.root, "Makefile"), "check:\n\t@true\n");
      writeFileSync(join(ctx.root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
      return ctx;
    }],
    when: ["selecting the gate", (ctx) => ({ ctx, gate: selectScopedGate(ctx.root) })],
    then: ["tools/gate.sh owns the full contract", ({ ctx, gate }) => {
      expect(gate).toEqual({ command: "bash", args: ["tools/gate.sh"], source: "tools/gate.sh" });
      ctx.cleanup();
    }],
  });

  unit("scoped gate runs only after dependency admission and preserves every lock", {
    given: ["a tracked repository and an admitted dependency plan", () => {
      const ctx = fixture();
      writeNodeRoot(ctx.root);
      runWorktreeCommand("git", ["init", "-q"], { cwd: ctx.root });
      runWorktreeCommand("git", ["add", "package.json", "package-lock.json"], { cwd: ctx.root });
      return ctx;
    }],
    when: ["running an explicit gate", (ctx) => {
      const calls = [];
      const run = (command, args, options) => {
        if (command === "gate-probe") {
          calls.push({ command, args, env: options.env });
          return { status: 0, stdout: "", stderr: "" };
        }
        return runWorktreeCommand(command, args, options);
      };
      const provision = ({ context }) => ({
        repoRoot: context.repoRoot,
        commonDir: context.commonDir,
        results: [{ ecosystem: "node", root: context.repoRoot, status: "ready", mode: "immutable-link" }],
        skipped: [],
        ok: true,
        planned: false,
      });
      return {
        ctx,
        calls,
        result: runScopedGate({ root: ctx.root, explicitCommand: ["gate-probe", "full"], run, provision }),
      };
    }],
    then: ["the gate is green, locked and argv-preserving", ({ ctx, calls, result }) => {
      expect(result).toMatchObject({ status: "green", exitCode: 0, locksUnchanged: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ command: "gate-probe", args: ["full"] });
      expect(calls[0].env.UV_LOCKED).toBe("1");
      ctx.cleanup();
    }],
  });
});
