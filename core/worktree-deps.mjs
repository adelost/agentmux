// Reproducible dependency bootstrap for isolated git worktrees.
// WHAT: Discovers every tracked npm/uv dependency root, provisions it without
// mutating locks, and shares only immutable npm trees keyed by their inputs.
// WHY: Blind links to a mutable checkout can silently swap compiler versions;
// Python virtualenvs also retain checkout-specific editable paths.

import { createHash, randomUUID } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { spawnSync } from "child_process";

const MARKER_VERSION = 1;
const CACHE_DIR = "agentmux-worktree-deps";
const LINK_MARKER = ".agentmux-worktree-links.json";

/** WHAT: Dispatches one argv-safe child process. WHY: Keeps shell interpolation out of installs and gates. */
export function runWorktreeCommand(command, args = [], {
  cwd = process.cwd(),
  capture = false,
  env = process.env,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  return {
    status: result.status ?? (result.error ? 1 : 0),
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: result.error || null,
  };
}

/** WHAT: Calculates a SHA-256 content identity. WHY: Keeps cache addressing independent from mutable paths. */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** WHAT: Calculates one file content identity. WHY: Prevents timestamps from changing dependency cache keys. */
export function hashFile(path) {
  return sha256(readFileSync(path));
}

/** WHAT: Normalizes object key order recursively. WHY: Keeps semantic JSON comparisons independent from serialization order. */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

/** WHAT: Compares two JSON values semantically. WHY: Prevents harmless key ordering from invalidating exact metadata. */
function sameJson(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

/** WHAT: Resolves successful captured child output. WHY: Keeps failed discovery commands from becoming empty configuration. */
function captured(run, command, args, options) {
  const result = run(command, args, { ...options, capture: true });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || "unknown error").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

/** WHAT: Resolves checkout root, common Git directory, and tracked files. WHY: Keeps caches outside disposable worktrees. */
export function resolveWorktreeContext(path = process.cwd(), { run = runWorktreeCommand } = {}) {
  const cwd = resolve(path);
  const repoRoot = captured(run, "git", ["-C", cwd, "rev-parse", "--show-toplevel"], { cwd });
  const rawCommon = captured(run, "git", ["-C", repoRoot, "rev-parse", "--git-common-dir"], { cwd: repoRoot });
  const commonDir = resolve(repoRoot, rawCommon);
  const trackedRaw = captured(run, "git", ["-C", repoRoot, "ls-files", "-z"], { cwd: repoRoot });
  const trackedFiles = trackedRaw.split("\0").filter(Boolean);
  return { repoRoot: realpathSync(repoRoot), commonDir: realpathSync(commonDir), trackedFiles };
}

/** WHAT: Maps a package manifest to its owning npm lock. WHY: Prevents uncovered nested compilers from being skipped. */
function nodeManifestCoveredBy(root, lockRoots) {
  return lockRoots.some((candidate) => {
    if (root === candidate.root) return true;
    if (!root.startsWith(`${candidate.root}${sep}`)) return false;
    const key = relative(candidate.root, root).split(sep).join("/");
    try {
      const packages = JSON.parse(readFileSync(candidate.lock, "utf8")).packages || {};
      return Object.hasOwn(packages, key);
    } catch {
      return false;
    }
  });
}

/** WHAT: Maps a Python manifest to its enclosing uv root. WHY: Keeps nested uv projects from duplicate provisioning. */
function pythonManifestCoveredBy(root, roots) {
  return roots.some((candidate) => root === candidate || root.startsWith(`${candidate}${sep}`));
}

/** WHAT: Maps tracked lockfiles to dependency roots. WHY: Keeps root and nested UI compilers separately versioned. */
export function discoverDependencyRoots(repoRoot, trackedFiles) {
  const node = trackedFiles
    .filter((file) => basename(file) === "package-lock.json")
    .map((file) => ({ ecosystem: "node", root: resolve(repoRoot, dirname(file)), lock: resolve(repoRoot, file) }))
    .sort((a, b) => a.root.localeCompare(b.root));
  const python = trackedFiles
    .filter((file) => basename(file) === "uv.lock")
    .map((file) => ({ ecosystem: "python", root: resolve(repoRoot, dirname(file)), lock: resolve(repoRoot, file) }))
    .sort((a, b) => a.root.localeCompare(b.root));

  const pythonRoots = python.map((item) => item.root);
  const unsupported = [];
  for (const file of trackedFiles) {
    const name = basename(file);
    const root = resolve(repoRoot, dirname(file));
    if (name === "package.json" && !nodeManifestCoveredBy(root, node)) {
      unsupported.push({ ecosystem: "node", root, reason: "tracked package.json has no covering package-lock.json" });
    }
    if (name === "pyproject.toml" && !pythonManifestCoveredBy(root, pythonRoots)) {
      unsupported.push({ ecosystem: "python", root, reason: "tracked pyproject.toml has no covering uv.lock" });
    }
  }
  return { node, python, unsupported };
}

/** WHAT: Builds one npm cache input identity. WHY: Prevents runtime or repository config drift from sharing trees. */
function nodeInput(root, repoRoot, npmVersion) {
  const packagePath = join(root, "package.json");
  const lockPath = join(root, "package-lock.json");
  if (!existsSync(packagePath)) throw new Error(`missing ${packagePath}`);
  const npmrcPath = join(root, ".npmrc");
  const input = {
    repoRelativeRoot: relative(repoRoot, root) || ".",
    packageHash: hashFile(packagePath),
    lockHash: hashFile(lockPath),
    npmrcHash: existsSync(npmrcPath) ? hashFile(npmrcPath) : null,
    npmVersion,
    platform: process.platform,
    arch: process.arch,
    nodeModulesAbi: process.versions.modules,
  };
  return { ...input, key: sha256(JSON.stringify(input)).slice(0, 32) };
}

/** WHAT: Loads package identities from a source npm lock. WHY: Keeps root metadata outside installed-tree comparison. */
function desiredNodePackages(lockPath) {
  const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
  return Object.fromEntries(Object.entries(parsed.packages || {}).filter(([key]) => key !== ""));
}

/** WHAT: Normalizes npm install-only metadata. WHY: Keeps ideally-inert hints from masking exact package identity. */
function comparableNodePackages(packages) {
  return Object.fromEntries(Object.entries(packages).map(([key, raw]) => {
    const entry = { ...raw };
    // npm adds this install-state hint to node_modules/.package-lock.json;
    // it is not a package identity/version field and never appears in source locks.
    delete entry.ideallyInert;
    return [key, entry];
  }));
}

/** WHAT: Compares installed npm metadata with the tracked lock. WHY: Prevents stale compilers from entering shared caches. */
export function nodeTreeMatches(root) {
  const installedPath = join(root, "node_modules", ".package-lock.json");
  const desiredPath = join(root, "package-lock.json");
  if (!existsSync(installedPath) || !existsSync(desiredPath)) return false;
  try {
    const installed = JSON.parse(readFileSync(installedPath, "utf8")).packages || {};
    return sameJson(
      comparableNodePackages(desiredNodePackages(desiredPath)),
      comparableNodePackages(installed),
    );
  } catch {
    return false;
  }
}

/** WHAT: Resolves whether an npm tree can move safely. WHY: Keeps workspace and file links checkout-local. */
export function nodeTreeIsRelocatable(root) {
  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  if (packageJson.workspaces) return false;
  return !Object.values(desiredNodePackages(join(root, "package-lock.json")))
    .some((entry) => entry?.link === true || String(entry?.resolved || "").startsWith("file:"));
}

/** WHAT: Compares one bootstrap marker with expected input. WHY: Prevents stale cache and environment reuse. */
function markerMatches(markerPath, input) {
  if (!existsSync(markerPath)) return false;
  try {
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    return marker.version === MARKER_VERSION && sameJson(marker.input, input);
  } catch {
    return false;
  }
}

/** WHAT: Resolves one symbolic-link target. WHY: Keeps link-farm verification exact across relative and absolute links. */
function linkTarget(path) {
  if (!existsSync(path) && !lstatSafe(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isSymbolicLink()) return null;
  return resolve(dirname(path), readlinkSync(path));
}

/** WHAT: Loads link-aware file state without throwing. WHY: Keeps missing dependency roots in normal control flow. */
function lstatSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

/** WHAT: Compares a node link farm with its immutable cache. WHY: Prevents partial or foreign farms from passing checks. */
function nodeLinkFarmReady(path, cacheModules, key) {
  const stat = lstatSafe(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) return false;
  if (!markerMatches(join(path, LINK_MARKER), { cacheModules, key })) return false;
  try {
    return readdirSync(cacheModules).every((name) => {
      const linked = join(path, name);
      return lstatSafe(linked)?.isSymbolicLink() && linkTarget(linked) === join(cacheModules, name);
    });
  } catch {
    return false;
  }
}

/** WHAT: Builds a Git-ignored package link farm. WHY: Keeps root node_modules a real ignored directory. */
function createNodeLinkFarm(path, cacheModules, key) {
  const stat = lstatSafe(path);
  if (stat) rmSync(path, { recursive: !stat.isSymbolicLink(), force: true });
  mkdirSync(path);
  for (const name of readdirSync(cacheModules)) {
    symlinkSync(join(cacheModules, name), join(path, name), "dir");
  }
  writeFileSync(join(path, LINK_MARKER), `${JSON.stringify({
    version: MARKER_VERSION,
    input: { cacheModules, key },
  }, null, 2)}\n`);
}

/** WHAT: Compares an npm cache entry with expected input. WHY: Prevents partial staging directories from being shared. */
function validateNodeCache(cacheEntry, input) {
  const marker = join(cacheEntry, "manifest.json");
  const modules = join(cacheEntry, "node_modules");
  return existsSync(modules) && markerMatches(marker, input);
}

/** WHAT: Dispatches a lock-preserving npm clean install. WHY: Prevents package drift during worktree provisioning. */
function installNode(root, run) {
  const before = hashFile(join(root, "package-lock.json"));
  const result = run("npm", ["ci"], {
    cwd: root,
    env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
  });
  const after = hashFile(join(root, "package-lock.json"));
  if (before !== after) throw new Error("npm ci mutated package-lock.json");
  if (result.status !== 0) throw new Error(`npm ci failed in ${root}`);
  if (!nodeTreeMatches(root)) throw new Error(`npm ci produced a tree that does not match ${join(root, "package-lock.json")}`);
}

/** WHAT: Stores an exact npm tree under its immutable key. WHY: Keeps concurrent bootstrap writes atomically isolated. */
function promoteNodeCache({ root, cacheEntry, input }) {
  const cacheParent = dirname(cacheEntry);
  mkdirSync(cacheParent, { recursive: true });
  const staging = `${cacheEntry}.tmp-${process.pid}-${randomUUID()}`;
  mkdirSync(staging);
  renameSync(join(root, "node_modules"), join(staging, "node_modules"));
  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify({ version: MARKER_VERSION, input }, null, 2)}\n`);
  try {
    renameSync(staging, cacheEntry);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (!validateNodeCache(cacheEntry, input)) throw error;
  }
}

/** WHAT: Builds one runnable npm dependency root. WHY: Prevents mutable cross-worktree compiler sharing. */
export function provisionNodeRoot({
  root,
  repoRoot,
  commonDir,
  check = false,
  dryRun = false,
  run = runWorktreeCommand,
  npmVersion = null,
}) {
  let resolvedNpmVersion = npmVersion;
  if (resolvedNpmVersion == null) {
    const npm = run("npm", ["--version"], { cwd: root, capture: true });
    if (npm.status !== 0) throw new Error("npm is required for tracked package-lock.json");
    resolvedNpmVersion = String(npm.stdout || "").trim();
  }
  const input = nodeInput(root, repoRoot, resolvedNpmVersion);
  const target = join(root, "node_modules");
  const relocatable = nodeTreeIsRelocatable(root);
  const cacheEntry = join(commonDir, CACHE_DIR, "node", input.key);
  const cacheModules = join(cacheEntry, "node_modules");
  const cacheReady = relocatable && validateNodeCache(cacheEntry, input);
  const stat = lstatSafe(target);
  const exactLink = cacheReady && nodeLinkFarmReady(target, cacheModules, input.key) && nodeTreeMatches(root);
  const exactLocal = stat && !stat.isSymbolicLink() && !existsSync(join(target, LINK_MARKER)) && nodeTreeMatches(root);

  if (exactLink) return { ecosystem: "node", root, status: "ready", mode: "immutable-link", key: input.key };
  if (exactLocal && !relocatable) return { ecosystem: "node", root, status: "ready", mode: "local-workspace", key: input.key };
  if (check && exactLocal) return { ecosystem: "node", root, status: "ready", mode: "local-exact", key: input.key };
  if (check) return {
    ecosystem: "node", root, status: "missing",
    mode: cacheReady ? "link-required" : "install-required", key: input.key,
  };
  if (dryRun) return {
    ecosystem: "node", root, status: "planned",
    mode: cacheReady ? "would-link"
      : exactLocal && relocatable ? "would-promote-cache"
        : relocatable ? "would-install-cache" : "would-install-local",
    key: input.key,
  };

  if (cacheReady) {
    createNodeLinkFarm(target, cacheModules, input.key);
    return { ecosystem: "node", root, status: "ready", mode: "immutable-link", key: input.key };
  }
  if (existsSync(cacheEntry)) {
    throw new Error(`immutable npm cache is corrupt: ${cacheEntry} (remove that entry and retry)`);
  }
  if (stat?.isSymbolicLink()) rmSync(target, { force: true });
  else if (stat && existsSync(join(target, LINK_MARKER))) rmSync(target, { recursive: true, force: true });
  if (!nodeTreeMatches(root)) installNode(root, run);
  if (!relocatable) {
    return { ecosystem: "node", root, status: "ready", mode: "local-workspace", key: input.key };
  }
  promoteNodeCache({ root, cacheEntry, input });
  createNodeLinkFarm(target, cacheModules, input.key);
  return { ecosystem: "node", root, status: "ready", mode: "immutable-link", key: input.key };
}

/** WHAT: Builds one uv environment input identity. WHY: Keeps lock and manifest drift visible per worktree. */
function pythonInput(root, repoRoot) {
  const pyproject = join(root, "pyproject.toml");
  const lock = join(root, "uv.lock");
  if (!existsSync(pyproject)) throw new Error(`missing ${pyproject}`);
  return {
    repoRelativeRoot: relative(repoRoot, root) || ".",
    pyprojectHash: hashFile(pyproject),
    lockHash: hashFile(lock),
  };
}

/** WHAT: Builds one local locked Python environment. WHY: Prevents editable imports from crossing checkout boundaries. */
export function provisionPythonRoot({
  root,
  repoRoot,
  check = false,
  dryRun = false,
  run = runWorktreeCommand,
}) {
  const input = pythonInput(root, repoRoot);
  const venv = join(root, ".venv");
  const marker = join(venv, ".agentmux-worktree-deps.json");
  const stat = lstatSafe(venv);
  if (stat?.isSymbolicLink()) {
    if (check) return { ecosystem: "python", root, status: "unsafe", mode: "shared-venv" };
    if (!dryRun) rmSync(venv, { force: true });
  }
  if (dryRun) return { ecosystem: "python", root, status: "planned", mode: "would-sync-local-locked" };

  const uv = run("uv", ["--version"], { cwd: root, capture: true });
  if (uv.status !== 0) throw new Error("uv is required for tracked uv.lock");
  const env = { ...process.env, UV_LOCKED: "1" };
  const verified = existsSync(join(venv, "bin", "python"))
    && run("uv", ["sync", "--locked", "--check"], { cwd: root, capture: true, env }).status === 0;
  if (check) return {
    ecosystem: "python", root,
    status: verified && markerMatches(marker, input) ? "ready" : "missing",
    mode: "local-venv",
  };
  if (!verified || !markerMatches(marker, input)) {
    const before = hashFile(join(root, "uv.lock"));
    const result = run("uv", ["sync", "--locked"], { cwd: root, env });
    const after = hashFile(join(root, "uv.lock"));
    if (before !== after) throw new Error("uv sync --locked mutated uv.lock");
    if (result.status !== 0) throw new Error(`uv sync --locked failed in ${root}`);
  }
  mkdirSync(venv, { recursive: true });
  writeFileSync(marker, `${JSON.stringify({ version: MARKER_VERSION, input }, null, 2)}\n`);
  return { ecosystem: "python", root, status: "ready", mode: "local-venv" };
}

/** WHAT: Builds every tracked dependency root. WHY: Keeps monorepo gate coverage complete and explicit. */
export function provisionWorktreeDependencies({
  root = process.cwd(),
  context = null,
  check = false,
  dryRun = false,
  run = runWorktreeCommand,
} = {}) {
  const resolved = context || resolveWorktreeContext(root, { run });
  const discovered = discoverDependencyRoots(resolved.repoRoot, resolved.trackedFiles);
  const results = [];
  const skipped = [...discovered.unsupported];
  for (const item of discovered.node) {
    try {
      results.push(provisionNodeRoot({
        root: item.root, repoRoot: resolved.repoRoot, commonDir: resolved.commonDir,
        check, dryRun, run,
      }));
    } catch (error) {
      skipped.push({ ecosystem: "node", root: item.root, reason: error.message });
    }
  }
  for (const item of discovered.python) {
    try {
      results.push(provisionPythonRoot({
        root: item.root, repoRoot: resolved.repoRoot, check, dryRun, run,
      }));
    } catch (error) {
      skipped.push({ ecosystem: "python", root: item.root, reason: error.message });
    }
  }
  const ready = results.every((item) => item.status === "ready") && skipped.length === 0;
  const planned = dryRun && results.every((item) => item.status === "ready" || item.status === "planned")
    && skipped.length === 0;
  return {
    repoRoot: resolved.repoRoot,
    commonDir: resolved.commonDir,
    results,
    skipped,
    ok: ready,
    planned,
  };
}

/** WHAT: Formats dependency admission and skips. WHY: Keeps incomplete gate scope visible to owners and brokers. */
export function formatWorktreeDeps(result) {
  const lines = [`Worktree dependencies: ${result.repoRoot}`];
  for (const item of result.results) {
    const rel = relative(result.repoRoot, item.root) || ".";
    const icon = item.status === "ready" ? "READY" : item.status === "planned" ? "PLAN" : "MISSING";
    lines.push(`  ${icon.padEnd(7)} ${item.ecosystem.padEnd(6)} ${rel} · ${item.mode}`);
  }
  if (!result.results.length && !result.skipped.length) lines.push("  READY   no tracked npm/uv dependency roots");
  else if (!result.results.length) lines.push("  Ready dependency roots: none");
  if (!result.skipped.length) lines.push("  Skipped: none");
  for (const item of result.skipped) {
    const rel = relative(result.repoRoot, item.root) || ".";
    lines.push(`  SKIPPED ${item.ecosystem.padEnd(6)} ${rel} · ${item.reason}`);
  }
  return lines.join("\n");
}

/** WHAT: Resolves the repository-owned full gate. WHY: Prevents ad hoc partial commands from claiming full proof. */
export function selectScopedGate(repoRoot, explicit = []) {
  if (explicit.length) return { command: explicit[0], args: explicit.slice(1), source: "explicit" };
  if (existsSync(join(repoRoot, "tools", "gate.sh"))) {
    return { command: "bash", args: ["tools/gate.sh"], source: "tools/gate.sh" };
  }
  const makefile = join(repoRoot, "Makefile");
  if (existsSync(makefile) && /^check\s*:/mu.test(readFileSync(makefile, "utf8"))) {
    return { command: "make", args: ["check"], source: "Makefile check" };
  }
  const packagePath = join(repoRoot, "package.json");
  if (existsSync(packagePath)) {
    const scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts || {};
    if (scripts.check) return { command: "npm", args: ["run", "check"], source: "package.json check" };
    if (scripts.test) return { command: "npm", args: ["test"], source: "package.json test" };
  }
  return null;
}

/** WHAT: Maps tracked dependency locks to content identities. WHY: Prevents green gates from hiding lock mutations. */
export function snapshotLocks(repoRoot, trackedFiles) {
  return Object.fromEntries(trackedFiles
    .filter((file) => basename(file) === "package-lock.json" || basename(file) === "uv.lock")
    .map((file) => [file, hashFile(join(repoRoot, file))]));
}

/** WHAT: Dispatches dependency admission and one full gate. WHY: Keeps skipped roots and lock drift red. */
export function runScopedGate({
  root = process.cwd(),
  explicitCommand = [],
  dryRun = false,
  run = runWorktreeCommand,
  provision = provisionWorktreeDependencies,
} = {}) {
  const context = resolveWorktreeContext(root, { run });
  const dependencies = provision({ root: context.repoRoot, context, dryRun, run });
  const gate = selectScopedGate(context.repoRoot, explicitCommand);
  if (dryRun) {
    const canRun = dependencies.planned && Boolean(gate);
    return { dependencies, gate, status: canRun ? "planned" : "blocked", exitCode: canRun ? 0 : 1 };
  }
  if (!dependencies.ok || !gate) {
    return { dependencies, gate, status: "blocked", exitCode: 1 };
  }
  const before = snapshotLocks(context.repoRoot, context.trackedFiles);
  const result = run(gate.command, gate.args, {
    cwd: context.repoRoot,
    env: { ...process.env, UV_LOCKED: "1" },
  });
  const after = snapshotLocks(context.repoRoot, context.trackedFiles);
  const locksUnchanged = sameJson(before, after);
  return {
    dependencies,
    gate,
    status: result.status === 0 && locksUnchanged ? "green" : "red",
    exitCode: result.status === 0 && locksUnchanged ? 0 : 1,
    commandExitCode: result.status,
    locksUnchanged,
  };
}
