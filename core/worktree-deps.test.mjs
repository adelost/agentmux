import { feature, unit, component, expect } from "bdd-vitest";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { mkdtempSync } from "fs";
import {
  discoverDependencyRoots,
  nodeCacheRoot,
  nodeTreeIsRelocatable,
  nodeTreeMatches,
  provisionNodeRoot,
  provisionPnpmRoot,
  provisionPythonRoot,
  provisionWorktreeDependencies,
  runScopedGate,
  runWorktreeCommand,
  selectScopedGate,
  snapshotLocks,
} from "./worktree-deps.mjs";

function fixture({ cacheOverride = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-worktree-deps-"));
  const commonDir = join(root, ".git");
  mkdirSync(commonDir);
  // Most tests pin the immutable cache under the fixture root for isolation.
  // Boundary coverage deliberately exercises the production default. Tests run
  // sequentially (preset), so restoring this process-wide override is safe.
  const priorCacheDir = process.env.AGENTMUX_WORKTREE_DEPS_DIR;
  if (cacheOverride) process.env.AGENTMUX_WORKTREE_DEPS_DIR = join(root, "deps-cache");
  else delete process.env.AGENTMUX_WORKTREE_DEPS_DIR;
  return { root, commonDir, cleanup: () => {
    if (priorCacheDir === undefined) delete process.env.AGENTMUX_WORKTREE_DEPS_DIR;
    else process.env.AGENTMUX_WORKTREE_DEPS_DIR = priorCacheDir;
    rmSync(root, { recursive: true, force: true });
  } };
}

function pathIsWithin(parent, candidate) {
  const rel = relative(realpathSync(parent), realpathSync(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
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
  writeFileSync(join(modules, "vitest", "index.js"), "export const source = 'cache';\n");
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
        reason: "tracked package.json has no covering package-lock.json or pnpm-lock.yaml",
      }]);
    }],
  });

  unit("a pnpm lock covers its root and every workspace member", {
    given: ["a pnpm workspace repo on disk", () => {
      const ctx = fixture();
      writeFileSync(join(ctx.root, "package.json"), `${JSON.stringify({ name: "fixture", packageManager: "pnpm@10.28.1" })}\n`);
      writeFileSync(join(ctx.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      writeFileSync(join(ctx.root, "pnpm-workspace.yaml"), "packages:\n  - \"packages/*\"\n  - \"!packages/legacy\"\n");
      mkdirSync(join(ctx.root, "packages", "app"), { recursive: true });
      mkdirSync(join(ctx.root, "packages", "legacy"), { recursive: true });
      writeFileSync(join(ctx.root, "packages", "app", "package.json"), "{}\n");
      writeFileSync(join(ctx.root, "packages", "legacy", "package.json"), "{}\n");
      return ctx;
    }],
    when: ["discovering dependency roots", (ctx) => ({
      ctx,
      result: discoverDependencyRoots(ctx.root, [
        "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml",
        "packages/app/package.json", "packages/legacy/package.json",
      ]),
    })],
    then: ["the root is a pnpm flavor and only the excluded member is uncovered", ({ ctx, result }) => {
      expect(result.node).toEqual([{
        ecosystem: "node", flavor: "pnpm", root: ctx.root, lock: join(ctx.root, "pnpm-lock.yaml"),
      }]);
      expect(result.unsupported).toEqual([{
        ecosystem: "node",
        root: join(ctx.root, "packages", "legacy"),
        reason: "tracked package.json has no covering package-lock.json or pnpm-lock.yaml",
      }]);
      ctx.cleanup();
    }],
  });

  unit("conflicting npm and pnpm locks in one root are refused instead of guessed", {
    given: ["a root tracking both lockfiles", () => [
      "package.json", "package-lock.json", "pnpm-lock.yaml",
    ]],
    when: ["discovering dependency roots", (files) => discoverDependencyRoots("/repo", files)],
    then: ["no node root is provisioned and the conflict is the stated reason", (result) => {
      expect(result.node).toEqual([]);
      expect(result.unsupported).toEqual([{
        ecosystem: "node",
        root: "/repo",
        reason: "conflicting package-lock.json and pnpm-lock.yaml in one root (keep exactly one)",
      }]);
    }],
  });

  unit("a pnpm root is provisioned by one frozen install and passes the next check", {
    given: ["a pnpm repo without node_modules", () => {
      const ctx = fixture();
      writeFileSync(join(ctx.root, "package.json"), `${JSON.stringify({ name: "fixture", packageManager: "pnpm@10.28.1" })}\n`);
      writeFileSync(join(ctx.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      return ctx;
    }],
    when: ["checking, installing, then checking again with a fake corepack", (ctx) => {
      const calls = [];
      const run = (command, args) => {
        calls.push([command, ...args]);
        if (args[1] === "--version") return { status: 0, stdout: "10.28.1\n", stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      };
      return {
        ctx,
        calls,
        before: provisionPnpmRoot({ root: ctx.root, repoRoot: ctx.root, check: true, run }),
        installed: provisionPnpmRoot({ root: ctx.root, repoRoot: ctx.root, run }),
        after: provisionPnpmRoot({ root: ctx.root, repoRoot: ctx.root, check: true, run }),
      };
    }],
    then: ["exactly one frozen install runs, the marker admits the tree, the lock is untouched", ({ ctx, calls, before, installed, after }) => {
      expect(before).toMatchObject({ status: "missing", mode: "install-required" });
      expect(installed).toMatchObject({ status: "ready", mode: "local-pnpm-store" });
      expect(after).toMatchObject({ status: "ready", mode: "local-pnpm-store" });
      expect(calls.filter((call) => call[2] === "install")).toEqual([
        ["corepack", "pnpm", "install", "--frozen-lockfile"],
      ]);
      expect(readFileSync(join(ctx.root, "pnpm-lock.yaml"), "utf8")).toBe("lockfileVersion: '9.0'\n");
      expect(existsSync(join(ctx.root, "node_modules", ".agentmux-worktree-deps.json"))).toBe(true);
      ctx.cleanup();
    }],
  });

  unit("a pnpm manifest selects the corepack gate runner and its lock is drift-guarded", {
    given: ["a pnpm repo with only an npm-style test script", () => {
      const ctx = fixture();
      writeFileSync(join(ctx.root, "package.json"), `${JSON.stringify({
        name: "fixture", packageManager: "pnpm@10.28.1", scripts: { test: "vitest run" },
      })}\n`);
      writeFileSync(join(ctx.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
      return ctx;
    }],
    when: ["selecting the gate and snapshotting locks", (ctx) => ({
      ctx,
      gate: selectScopedGate(ctx.root),
      locks: snapshotLocks(ctx.root, ["package.json", "pnpm-lock.yaml"]),
    })],
    then: ["corepack pnpm owns the script and pnpm-lock.yaml is fingerprinted", ({ ctx, gate, locks }) => {
      expect(gate).toEqual({ command: "corepack", args: ["pnpm", "test"], source: "package.json test" });
      expect(Object.keys(locks)).toEqual(["pnpm-lock.yaml"]);
      ctx.cleanup();
    }],
  });

  component("promotes an exact npm tree to an immutable lock-keyed cache and copies the worktree", {
    given: ["an exact local install", () => {
      const ctx = fixture();
      writeNodeRoot(ctx.root);
      writeInstalledTree(ctx.root);
      return ctx;
    }],
    when: ["checking, planning, provisioning, then checking again", (ctx) => {
      const startedAt = performance.now();
      const before = provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root,
        commonDir: ctx.commonDir, check: true, npmVersion: "11.6.0" });
      const dry = provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root,
        commonDir: ctx.commonDir, dryRun: true, npmVersion: "11.6.0" });
      const excludedAfterReadOnly = existsSync(join(ctx.commonDir, "info", "exclude"));
      const first = provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root,
        commonDir: ctx.commonDir, npmVersion: "11.6.0" });
      const second = provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root,
        commonDir: ctx.commonDir, check: true, npmVersion: "11.6.0" });
      return { before, dry, excludedAfterReadOnly, first, second, ctx, startedAt };
    }],
    then: ["read-only modes stay mutation-free before the tree becomes an immutable reusable copy",
      async ({ before, dry, excludedAfterReadOnly, first, second, ctx, startedAt }) => {
      const proofDelayMs = process.env.AMUX_MEASUREMENT_PHASE === "red" ? 600
        : process.env.AMUX_MEASUREMENT_PHASE === "green" ? 150 : 0;
      if (proofDelayMs && process.env.AMUX_MEASUREMENT_OUTPUT) writeFileSync(
        process.env.AMUX_MEASUREMENT_OUTPUT, JSON.stringify({
          metric: "immutable-copy-timeout-fixture-delay", unit: "ms", operator: "<=",
          limit: 500, observed: proofDelayMs,
        }));
      if (proofDelayMs) await new Promise((resolve) => setTimeout(resolve, proofDelayMs));
      expect(before).toMatchObject({ status: "ready", mode: "local-exact" });
      expect(dry).toMatchObject({ status: "planned", mode: "would-promote-cache" });
      expect(excludedAfterReadOnly).toBe(false);
      expect(first).toMatchObject({ status: "ready", mode: "immutable-copy" });
      expect(second).toMatchObject({ status: "ready", mode: "immutable-copy", key: first.key });
      expect(lstatSync(join(ctx.root, "node_modules")).isSymbolicLink()).toBe(false);
      const target = realpathSync(join(ctx.root, "node_modules", "vitest"));
      expect(target).toBe(join(ctx.root, "node_modules", "vitest"));
      expect(existsSync(join(nodeCacheRoot(ctx.commonDir), "node", first.key,
        "node_modules", "vitest"))).toBe(true);
      writeFileSync(join(ctx.root, "node_modules", "vitest", "index.js"),
        "export const source = 'worktree';\n");
      expect(readFileSync(join(nodeCacheRoot(ctx.commonDir), "node", first.key,
        "node_modules", "vitest", "index.js"), "utf8")).toBe("export const source = 'cache';\n");
      // SKY-0105: a dep realpath must never land inside .git — Vite 6 (and any
      // tool with a `**/.git/**` deny) refuses to serve its own client from there.
      expect(target.includes(`${sep}.git${sep}`)).toBe(false);
      expect(nodeTreeMatches(ctx.root)).toBe(true);
      ctx.cleanup();
      const elapsedMs = Math.ceil(performance.now() - startedAt);
      if (process.env.CI) console.info(`worktree-deps immutable-copy operation runtime: ${elapsedMs}ms`);
      if (!proofDelayMs && process.env.AMUX_MEASUREMENT_OUTPUT) writeFileSync(
        process.env.AMUX_MEASUREMENT_OUTPUT, JSON.stringify({
          metric: "immutable-copy-component-runtime", unit: "ms", operator: "<=",
          limit: 500, observed: elapsedMs,
        }));
      expect(elapsedMs).toBeLessThanOrEqual(500);
    }],
  });

  unit("the shared cache and every resolved dep realpath live outside .git (SKY-0105)", {
    given: ["a worktree whose git dir is the conventional .git", () => {
      const ctx = fixture();
      writeNodeRoot(ctx.root);
      writeInstalledTree(ctx.root);
      return ctx;
    }],
    when: ["provisioning the immutable local copy", (ctx) => ({
      ctx,
      result: provisionNodeRoot({ root: ctx.root, repoRoot: ctx.root, commonDir: ctx.commonDir, npmVersion: "11.6.0" }),
    })],
    then: ["the cache root, and the realpath a consumer's require.resolve would see, avoid .git", ({ ctx, result }) => {
      expect(result).toMatchObject({ mode: "immutable-copy" });
      const cacheRoot = nodeCacheRoot(ctx.commonDir);
      expect(cacheRoot.includes(`${sep}.git${sep}`)).toBe(false);
      expect(cacheRoot.endsWith(`${sep}.git`)).toBe(false);
      // What Vite 6 self-aliases from: the realpath of a resolved package.
      const resolved = realpathSync(join(ctx.root, "node_modules", "vitest"));
      expect(resolved.includes(`${sep}.git${sep}`)).toBe(false);
      ctx.cleanup();
    }],
  });

  unit("a shared dependency realpath stays inside the repository and outside .git", {
    given: ["a linked worktree using the production cache location", () => {
      const ctx = fixture({ cacheOverride: false });
      const worktree = join(ctx.root, ".agents", "7", "worktree");
      mkdirSync(worktree, { recursive: true });
      writeNodeRoot(worktree);
      writeInstalledTree(worktree);
      return { ...ctx, worktree };
    }],
    when: ["provisioning the immutable local copy", (ctx) => ({
      ctx,
      result: provisionNodeRoot({ root: ctx.worktree, repoRoot: ctx.worktree,
        commonDir: ctx.commonDir, npmVersion: "11.6.0" }),
    })],
    then: ["the dependency is worktree-local while the shared cache satisfies both repository boundaries",
      ({ ctx, result }) => {
        try {
          const cacheRoot = nodeCacheRoot(ctx.commonDir);
          const resolved = realpathSync(join(ctx.worktree, "node_modules", "vitest"));
          const safeBoundaryCount = Number(pathIsWithin(ctx.worktree, resolved))
            + Number(pathIsWithin(ctx.root, cacheRoot))
            + Number(!pathIsWithin(ctx.commonDir, cacheRoot));
          if (process.env.AMUX_MEASUREMENT_OUTPUT) {
            writeFileSync(process.env.AMUX_MEASUREMENT_OUTPUT, JSON.stringify({
              metric: "safe-cache-path-boundaries",
              unit: "boundaries",
              operator: ">=",
              limit: 2,
              observed: safeBoundaryCount,
            }));
          }
          expect(safeBoundaryCount).toBeGreaterThan(2);
          expect(pathIsWithin(ctx.worktree, resolved)).toBe(true);
          expect(pathIsWithin(ctx.root, cacheRoot)).toBe(true);
          expect(pathIsWithin(ctx.commonDir, cacheRoot)).toBe(false);
          expect(result).toMatchObject({ status: "ready" });
          expect(readFileSync(join(ctx.commonDir, "info", "exclude"), "utf8"))
            .toContain(`/${relative(ctx.root, cacheRoot).split(sep).join("/")}/`);
        } finally {
          ctx.cleanup();
        }
      }],
  });

  unit("an override cannot put shared dependency realpaths beyond either safe boundary", {
    given: ["a conventional repository and both unsafe override directions", () => {
      const ctx = fixture();
      const external = mkdtempSync(join(tmpdir(), "amux-worktree-external-cache-"));
      const escaped = join(ctx.root, "symlink-cache");
      symlinkSync(external, escaped, "dir");
      return { ctx, external, unsafe: [join(ctx.root, "..", "outside-cache"),
        join(ctx.commonDir, "inside-git-cache"), escaped] };
    }],
    when: ["resolving each unsafe cache root", ({ ctx, external, unsafe }) => ({
      ctx,
      external,
      errors: unsafe.map((path) => {
        process.env.AGENTMUX_WORKTREE_DEPS_DIR = path;
        try { nodeCacheRoot(ctx.commonDir); return null; }
        catch (error) { return error; }
      }),
    })],
    then: ["all are rejected instead of silently recreating SRC-0107 or SKY-0105", ({ ctx, external, errors }) => {
      try {
        expect(errors).toHaveLength(3);
        for (const error of errors) {
          expect(error).toBeInstanceOf(Error);
          expect(error.message).toContain("inside the repository root and outside its Git common directory");
        }
      } finally {
        ctx.cleanup();
        rmSync(external, { recursive: true, force: true });
      }
    }],
  });

  component("a changed lock never reuses the previous compiler cache", {
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
      expect(realpathSync(join(ctx.root, "node_modules", "vitest")))
        .toBe(join(ctx.root, "node_modules", "vitest"));
      expect(existsSync(join(nodeCacheRoot(ctx.commonDir), "node", ctx.second.key,
        "node_modules", "vitest"))).toBe(true);
      expect(existsSync(join(nodeCacheRoot(ctx.commonDir), "node", ctx.first.key))).toBe(true);
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

  component("scoped gate runs only after dependency admission and preserves every lock", {
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
        results: [{ ecosystem: "node", root: context.repoRoot, status: "ready", mode: "immutable-copy" }],
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
