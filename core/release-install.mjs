import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  observeReleaseIdentity, RELEASE_MANIFEST_NAME, releaseReceiptPath,
} from "./release-identity.mjs";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const CONFIG_FILES = [".env", "agentmux.yaml"];
const INSTALLER_FILES = [
  "bin/install-release.mjs",
  "core/release-install.mjs",
  "core/release-identity.mjs",
];
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", ...options });
}

function hashBuffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function hashFile(path) {
  return hashBuffer(readFileSync(path));
}

function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function snapshotRuntimeConfig(repoRoot, installedRoot) {
  return CONFIG_FILES.flatMap((name) => {
    const source = [join(repoRoot, name), join(installedRoot, name)].find((path) => existsSync(path));
    return source ? [{ name, bytes: readFileSync(source) }] : [];
  });
}

function restoreRuntimeConfig(files, installedRoot) {
  for (const file of files) {
    const target = join(installedRoot, file.name);
    writeFileSync(target, file.bytes, { mode: 0o600 });
    chmodSync(target, 0o600);
  }
}

function verifyInstallerMatchesTarget(repoRoot, sourceSha) {
  for (const relative of INSTALLER_FILES) {
    const current = readFileSync(join(MODULE_ROOT, relative));
    const committed = run("git", ["show", `${sourceSha}:${relative}`], { cwd: repoRoot });
    if (hashBuffer(current) !== hashBuffer(Buffer.from(committed))) {
      throw new Error(`${relative} differs from explicit target ${sourceSha}; run the installer from that revision`);
    }
  }
}

/** WHAT: Checks one full immutable Git object identity. WHY: Prevents moving branches or abbreviations from authorizing a release. */
export function assertReleaseSha(sourceSha) {
  if (!COMMIT_SHA.test(String(sourceSha || ""))) {
    throw new Error("release --sha must be a lowercase 40-character commit SHA");
  }
  return sourceSha;
}

/** WHAT: Compares the target with fetched master. WHY: Prevents an exact stale SHA from leaving the fleet behind merged code. */
export function assertMasterReleaseTarget({ sourceSha, masterSha }) {
  assertReleaseSha(sourceSha);
  assertReleaseSha(masterSha);
  if (sourceSha !== masterSha) {
    throw new Error(`release SHA ${sourceSha} is not fetched origin/master ${masterSha}`);
  }
  return sourceSha;
}

/**
 * WHAT: Builds an npm artifact from git-archive bytes plus an embedded source manifest.
 * WHY: Prevents dirty, untracked, or feature-branch files from entering a release.
 */
export function stageReleaseArtifact({ repoRoot, sourceSha, outputRoot }) {
  assertReleaseSha(sourceSha);
  const root = resolve(repoRoot);
  const output = resolve(outputRoot);
  const source = join(output, "source");
  const archive = join(output, "source.tar");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  run("git", ["archive", "--format=tar", "--output", archive, sourceSha], { cwd: root });
  run("tar", ["-xf", archive, "-C", source]);
  const packageJson = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const manifest = { schemaVersion: 1, sourceSha, packageVersion: packageJson.version };
  writeFileSync(join(source, RELEASE_MANIFEST_NAME), `${JSON.stringify(manifest)}\n`);
  const preview = JSON.parse(run("npm", ["pack", "--dry-run", "--json"], { cwd: source }));
  manifest.files = Object.fromEntries(preview[0].files
    .map((file) => file.path)
    .filter((path) => path !== RELEASE_MANIFEST_NAME)
    .sort()
    .map((path) => [path, hashFile(join(source, path))]));
  writeFileSync(join(source, RELEASE_MANIFEST_NAME), `${JSON.stringify(manifest)}\n`);
  const packed = JSON.parse(run("npm", ["pack", "--json", "--pack-destination", output], { cwd: source }));
  const artifactPath = join(output, packed[0].filename);
  return {
    artifactPath,
    artifactSha256: hashFile(artifactPath),
    manifest,
  };
}

/**
 * WHAT: Builds one installed release from fetched master and publishes its verified host receipt.
 * WHY: Prevents global npm from following whichever feature branch a shared checkout exposes.
 */
export function installRelease({ repoRoot, sourceSha, home = homedir() }) {
  const root = realpathSync(resolve(repoRoot));
  const target = assertReleaseSha(sourceSha);
  const masterSha = run("git", ["rev-parse", "refs/remotes/origin/master"], { cwd: root }).trim();
  assertMasterReleaseTarget({ sourceSha: target, masterSha });
  verifyInstallerMatchesTarget(root, target);
  const sourceRemote = run("git", ["remote", "get-url", "origin"], { cwd: root }).trim();

  const globalNodeModules = run("npm", ["root", "--global"]).trim();
  const oldPackageRoot = join(globalNodeModules, "agentmux");
  const configs = snapshotRuntimeConfig(root, oldPackageRoot);
  const temporary = mkdtempSync(join(tmpdir(), "agentmux-release-"));
  try {
    const staged = stageReleaseArtifact({ repoRoot: root, sourceSha: target, outputRoot: join(temporary, "artifact") });
    run("npm", ["install", "--global", "--ignore-scripts", staged.artifactPath], { stdio: "inherit" });
    const packageRoot = realpathSync(join(run("npm", ["root", "--global"]).trim(), "agentmux"));
    if (lstatSync(join(globalNodeModules, "agentmux")).isSymbolicLink()
      || existsSync(join(packageRoot, ".git"))) {
      throw new Error("npm global agentmux still resolves to a mutable git checkout");
    }
    restoreRuntimeConfig(configs, packageRoot);
    run(process.execPath, [join(packageRoot, "bin", "install-hooks.mjs")], {
      env: { ...process.env, HOME: home },
      stdio: "inherit",
    });

    const prefix = run("npm", ["prefix", "--global"]).trim();
    const binaryRealpath = realpathSync(join(prefix, "bin", "amux"));
    const hookPaths = {
      eventHook: join(packageRoot, "bin", "amux-hook.mjs"),
      suggestionsGuard: join(home, ".agentmux", "hooks", "suggestions-write-guard.mjs"),
      suggestionsClient: join(home, ".agentmux", "bin", "amux-suggest.mjs"),
      suggestionsCore: join(home, ".agentmux", "core", "suggestions-authoring.mjs"),
    };
    const receipt = {
      schemaVersion: 1,
      sourceSha: target,
      sourceRepo: root,
      sourceRemote,
      sourceRef: "refs/heads/master",
      packageVersion: staged.manifest.packageVersion,
      artifactSha256: staged.artifactSha256,
      installedAt: new Date().toISOString(),
      packageRoot,
      binaryRealpath,
      hooks: Object.fromEntries(Object.entries(hookPaths).map(([key, path]) => [key, {
        path,
        sha256: hashFile(path),
        ...(key === "suggestionsGuard" ? { inlineMutationBlocked: true } : {}),
      }])),
      restoredConfig: configs.map((file) => file.name),
    };
    const identity = observeReleaseIdentity({
      runtimeRoot: packageRoot,
      entryPath: join(prefix, "bin", "amux"),
      home,
      receipt,
      readRemoteMaster: () => target,
    });
    if (!identity.ok) {
      throw new Error(`installed release failed identity verification: ${identity.issues.map((issue) => issue.detail).join("; ")}`);
    }
    atomicJson(releaseReceiptPath(home), receipt);
    return { ...receipt, identity };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
