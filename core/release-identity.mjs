import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, readFileSync, realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** WHAT: Names the source manifest embedded in each package. WHY: Keeps archived code identity independent from host receipts. */
export const RELEASE_MANIFEST_NAME = ".agentmux-release.json";
const RECEIPT_NAME = "release-receipt.json";
const HOOK_EVENTS = ["Stop", "Notification", "UserPromptSubmit", "SessionStart"];
const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT_SHA = /^[0-9a-f]{40}$/u;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function sha256(path) {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
  catch { return null; }
}

function realpath(path) {
  try { return realpathSync(path); }
  catch { return null; }
}

function hookCommands(settings, event) {
  return (settings?.hooks?.[event] || []).flatMap((entry) => entry.hooks || [])
    .map((hook) => String(hook.command || ""));
}

function receiptHookMatches(actual, expectedPath, expectedHash) {
  return actual?.path === expectedPath && actual?.sha256 === expectedHash;
}

function defaultGuardCanary(path) {
  return spawnSync(process.execPath, [path], {
    encoding: "utf8",
    input: JSON.stringify({
      tool_name: "Bash",
      tool_input: {
        command: "curl -X PATCH https://suggest.v1d.io/api/tickets/AI-0001/admin?project=ai",
      },
    }),
  });
}

function defaultRemoteMaster(remote, ref = "refs/heads/master") {
  const probe = spawnSync("git", ["ls-remote", "--exit-code", remote, ref], {
    encoding: "utf8",
    timeout: 3_000,
  });
  if (probe.status !== 0) throw new Error(String(probe.stderr || `git ls-remote exited ${probe.status}`).trim());
  const sourceSha = String(probe.stdout || "").trim().split(/\s+/u)[0];
  if (!COMMIT_SHA.test(sourceSha || "")) throw new Error("remote master returned no exact commit SHA");
  return sourceSha;
}

/** WHAT: Resolves the durable host receipt path. WHY: Keeps install evidence outside npm's replaceable package tree. */
export function releaseReceiptPath(home) {
  return join(home, ".agentmux", RECEIPT_NAME);
}

/** WHAT: Reads the source identity embedded in one package. WHY: Keeps runtime truth bound to archived bytes instead of a checkout. */
export function readReleaseManifest(runtimeRoot) {
  return readJson(join(runtimeRoot, RELEASE_MANIFEST_NAME));
}

/**
 * WHAT: Collects installed package, binary, receipt, hook hashes, registrations, and guard behavior.
 * WHY: Prevents matching versions from hiding mutable code or unloaded hooks.
 */
export function observeReleaseIdentity({
  runtimeRoot,
  entryPath,
  home,
  settings = readJson(join(home, ".claude", "settings.json")),
  receipt: suppliedReceipt = null,
  runGuardCanary = defaultGuardCanary,
  readRemoteMaster = defaultRemoteMaster,
}) {
  const issues = [];
  const warnings = [];
  const packageLink = resolve(runtimeRoot);
  const packageRoot = realpath(packageLink);
  const binaryRealpath = realpath(entryPath);
  let linked = false;
  try { linked = lstatSync(packageLink).isSymbolicLink(); }
  catch { issues.push({ code: "runtime-missing", detail: `runtime package is missing: ${packageLink}` }); }
  if (packageRoot && existsSync(join(packageRoot, ".git"))) linked = true;
  if (linked) {
    issues.push({ code: "linked-checkout", detail: "global package resolves into a git working tree" });
  }

  const manifest = packageRoot ? readReleaseManifest(packageRoot) : null;
  const packageJson = packageRoot ? readJson(join(packageRoot, "package.json")) : null;
  const receipt = suppliedReceipt || readJson(releaseReceiptPath(home));
  if (!manifest || manifest.schemaVersion !== 1 || !COMMIT_SHA.test(manifest.sourceSha || "")) {
    issues.push({ code: "manifest", detail: "installed package has no valid exact-SHA release manifest" });
  }
  if (!manifest?.files || typeof manifest.files !== "object" || Array.isArray(manifest.files)
    || Object.keys(manifest.files).length === 0) {
    issues.push({ code: "package-content", detail: "release manifest has no packed-file hashes" });
  } else if (packageRoot) {
    for (const [path, expectedHash] of Object.entries(manifest.files)) {
      const candidate = resolve(packageRoot, path);
      const rel = relative(packageRoot, candidate);
      if (!path || rel.startsWith("..") || isAbsolute(rel)
        || !SHA256.test(expectedHash) || sha256(candidate) !== expectedHash) {
        issues.push({ code: "package-content", detail: `installed package bytes differ at ${path}` });
        break;
      }
    }
  }
  if (!receipt || receipt.schemaVersion !== 1 || !COMMIT_SHA.test(receipt.sourceSha || "")) {
    issues.push({ code: "receipt", detail: "permanent release receipt is missing or invalid" });
  }
  if (!packageJson?.version || manifest?.packageVersion !== packageJson?.version
    || receipt?.packageVersion !== packageJson?.version) {
    issues.push({ code: "version", detail: "package version, embedded manifest, and host receipt disagree" });
  }
  if (manifest?.sourceSha !== receipt?.sourceSha) {
    issues.push({ code: "source-sha", detail: "embedded source SHA and host receipt disagree" });
  }
  let remoteMasterSha = null;
  if (receipt?.sourceRemote) {
    try {
      remoteMasterSha = readRemoteMaster(receipt.sourceRemote, receipt.sourceRef);
      if (remoteMasterSha !== receipt.sourceSha) {
        issues.push({ code: "master-drift", detail: `installed ${String(receipt.sourceSha || "missing").slice(0, 12)} is behind remote master ${remoteMasterSha.slice(0, 12)}` });
      }
    } catch (error) {
      warnings.push({ code: "master-unverified", detail: `remote master could not be verified: ${error.message}` });
    }
  } else {
    warnings.push({ code: "master-unverified", detail: "release receipt has no source remote" });
  }
  if (receipt?.packageRoot !== packageRoot || receipt?.binaryRealpath !== binaryRealpath
    || binaryRealpath !== (packageRoot ? realpath(join(packageRoot, "bin", "agent-cli.mjs")) : null)) {
    issues.push({ code: "realpath", detail: "binary realpath does not resolve inside the receipted package" });
  }
  if (!SHA256.test(receipt?.artifactSha256 || "")) {
    issues.push({ code: "artifact", detail: "release receipt has no valid artifact SHA-256" });
  }
  if (receipt?.hooks?.suggestionsGuard?.inlineMutationBlocked !== true) {
    issues.push({ code: "hook-receipt", detail: "release receipt does not attest the Suggestions guard canary" });
  }

  const expected = packageRoot ? {
    eventHook: join(packageRoot, "bin", "amux-hook.mjs"),
    suggestionsGuard: join(home, ".agentmux", "hooks", "suggestions-write-guard.mjs"),
    suggestionsClient: join(home, ".agentmux", "bin", "amux-suggest.mjs"),
    suggestionsCore: join(home, ".agentmux", "core", "suggestions-authoring.mjs"),
  } : {};
  const hashes = Object.fromEntries(Object.entries(expected).map(([key, path]) => [key, sha256(path)]));
  for (const key of Object.keys(expected)) {
    if (!hashes[key] || !receiptHookMatches(receipt?.hooks?.[key], expected[key], hashes[key])) {
      issues.push({ code: "hook-hash", detail: `${key} does not match the installed release receipt` });
    }
  }
  for (const event of HOOK_EVENTS) {
    if (!hookCommands(settings, event).some((command) => command.includes(`"${expected.eventHook}"`))) {
      issues.push({ code: "hook-registration", detail: `${event} does not execute the receipted event hook` });
    }
  }
  if (!hookCommands(settings, "PreToolUse").some(
    (command) => command.includes(`"${expected.suggestionsGuard}"`),
  )) {
    issues.push({ code: "hook-registration", detail: "PreToolUse does not execute the stable Suggestions guard" });
  }
  const canary = expected.suggestionsGuard
    ? runGuardCanary(expected.suggestionsGuard)
    : { status: null, stderr: "" };
  if (canary.status !== 2 || !String(canary.stderr || "").includes("BLOCKED")) {
    issues.push({ code: "hook-canary", detail: "Suggestions guard failed its inline-mutation blocking canary" });
  }

  const hookIssue = issues.some((issue) => issue.code.startsWith("hook-"));
  return {
    ok: issues.length === 0,
    sourceSha: manifest?.sourceSha || receipt?.sourceSha || null,
    packageVersion: packageJson?.version || null,
    packageRoot,
    binaryRealpath,
    hooksVerified: !hookIssue,
    issues,
    warnings,
    remoteMasterSha,
  };
}

/** WHAT: Formats installed release identity for doctor. WHY: Keeps mutable package and hook drift visible to operators. */
export function checkReleaseIdentity(identity) {
  if (identity?.ok) {
    if (identity.warnings?.length) {
      return {
        name: "release identity",
        status: "warn",
        detail: identity.warnings[0].detail,
        hint: "verify network access to remote master, then rerun amux doctor",
      };
    }
    return {
      name: "release identity",
      status: "ok",
      detail: `v${identity.packageVersion} @ ${identity.sourceSha.slice(0, 12)} · immutable package · hooks verified`,
      hint: "",
    };
  }
  return {
    name: "release identity",
    status: "fail",
    detail: identity?.issues?.[0]?.detail || "release identity could not be observed",
    hint: "install fetched master: node bin/install-release.mjs --sha <40-char origin/master SHA>",
  };
}
