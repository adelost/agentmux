import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import {
  RELEASE_MANIFEST_NAME,
  observeReleaseIdentity,
  releaseReceiptPath,
} from "./release-identity.mjs";

const SOURCE_SHA = "a".repeat(40);
const VERSION = "1.25.0";
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function fixture({ linkedCheckout = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), "amux-release-identity-"));
  const home = join(base, "home");
  const packageLink = join(base, "prefix", "lib", "node_modules", "agentmux");
  const packageRoot = linkedCheckout ? join(base, "shared-checkout") : packageLink;
  const binary = join(base, "prefix", "bin", "amux");
  mkdirSync(packageRoot, { recursive: true });
  if (linkedCheckout) {
    mkdirSync(join(packageRoot, ".git"));
    mkdirSync(dirname(packageLink), { recursive: true });
    symlinkSync(packageRoot, packageLink);
  }
  write(join(packageRoot, "package.json"), `${JSON.stringify({ name: "agentmux", version: VERSION })}\n`);
  write(join(packageRoot, RELEASE_MANIFEST_NAME), `${JSON.stringify({
    schemaVersion: 1, sourceSha: SOURCE_SHA, packageVersion: VERSION,
  })}\n`);
  for (const path of [
    join(packageRoot, "bin", "agent-cli.mjs"),
    join(packageRoot, "bin", "amux-hook.mjs"),
    join(home, ".agentmux", "hooks", "suggestions-write-guard.mjs"),
    join(home, ".agentmux", "bin", "amux-suggest.mjs"),
    join(home, ".agentmux", "core", "suggestions-authoring.mjs"),
  ]) write(path, `// ${path}\n`);
  mkdirSync(dirname(binary), { recursive: true });
  symlinkSync(join(packageRoot, "bin", "agent-cli.mjs"), binary);

  const actualRoot = realpathSync(packageLink);
  const eventHook = join(actualRoot, "bin", "amux-hook.mjs");
  const guard = join(home, ".agentmux", "hooks", "suggestions-write-guard.mjs");
  const client = join(home, ".agentmux", "bin", "amux-suggest.mjs");
  const core = join(home, ".agentmux", "core", "suggestions-authoring.mjs");
  const settings = { hooks: {
    Stop: [{ hooks: [{ type: "command", command: `exec node "${eventHook}"` }] }],
    Notification: [{ hooks: [{ type: "command", command: `exec node "${eventHook}"` }] }],
    UserPromptSubmit: [{ hooks: [{ type: "command", command: `exec node "${eventHook}"` }] }],
    SessionStart: [{ hooks: [{ type: "command", command: `exec node "${eventHook}"` }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `exec node "${guard}"` }] }],
  } };
  write(join(home, ".claude", "settings.json"), `${JSON.stringify(settings)}\n`);
  write(releaseReceiptPath(home), `${JSON.stringify({
    schemaVersion: 1,
    sourceSha: SOURCE_SHA,
    sourceRepo: packageRoot,
    sourceRemote: "https://github.com/adelost/agentmux.git",
    packageVersion: VERSION,
    artifactSha256: "b".repeat(64),
    packageRoot: actualRoot,
    binaryRealpath: realpathSync(binary),
    hooks: {
      eventHook: { path: eventHook, sha256: sha256(eventHook) },
      suggestionsGuard: { path: guard, sha256: sha256(guard), inlineMutationBlocked: true },
      suggestionsClient: { path: client, sha256: sha256(client) },
      suggestionsCore: { path: core, sha256: sha256(core) },
    },
  })}\n`);
  return {
    base, home, packageLink, binary,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

feature("installed release identity", () => {
  component("an immutable package with exact receipt and live hook canary is healthy", {
    given: ["a copied global package and matching permanent receipt", () => fixture()],
    when: ["observing the code, binary and hook installation", (ctx) => ({
      ctx,
      result: observeReleaseIdentity({
        runtimeRoot: ctx.packageLink,
        entryPath: ctx.binary,
        home: ctx.home,
        readRemoteMaster: () => SOURCE_SHA,
        runGuardCanary: () => ({ status: 2, stderr: "BLOCKED: direct inline mutation" }),
      }),
    })],
    then: ["the exact source SHA and every hook are verified", ({ ctx, result }) => {
      expect(result).toMatchObject({
        ok: true,
        sourceSha: SOURCE_SHA,
        packageVersion: VERSION,
        hooksVerified: true,
        issues: [],
      });
      ctx.cleanup();
    }],
  });

  component("an npm link into a shared git checkout is red even with a plausible receipt", {
    given: ["a global package symlinked to a feature checkout", () => fixture({ linkedCheckout: true })],
    when: ["observing the installed runtime", (ctx) => ({
      ctx,
      result: observeReleaseIdentity({
        runtimeRoot: ctx.packageLink,
        entryPath: ctx.binary,
        home: ctx.home,
        readRemoteMaster: () => SOURCE_SHA,
        runGuardCanary: () => ({ status: 2, stderr: "BLOCKED" }),
      }),
    })],
    then: ["the worktree link is a permanent gate failure", ({ ctx, result }) => {
      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("linked-checkout");
      ctx.cleanup();
    }],
  });

  component("a guard that no longer blocks inline mutation invalidates the release receipt", {
    given: ["an otherwise matching immutable installation", () => fixture()],
    when: ["running the behavioral guard canary", (ctx) => ({
      ctx,
      result: observeReleaseIdentity({
        runtimeRoot: ctx.packageLink,
        entryPath: ctx.binary,
        home: ctx.home,
        readRemoteMaster: () => SOURCE_SHA,
        runGuardCanary: () => ({ status: 0, stderr: "" }),
      }),
    })],
    then: ["doctor-facing identity is red on behavior, not merely file presence", ({ ctx, result }) => {
      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("hook-canary");
      ctx.cleanup();
    }],
  });

  component("a newer remote master makes an otherwise valid installed receipt red", {
    given: ["an immutable release followed by one uninstalled master merge", () => fixture()],
    when: ["comparing the receipt with the remote branch identity", (ctx) => ({
      ctx,
      result: observeReleaseIdentity({
        runtimeRoot: ctx.packageLink,
        entryPath: ctx.binary,
        home: ctx.home,
        readRemoteMaster: () => "c".repeat(40),
        runGuardCanary: () => ({ status: 2, stderr: "BLOCKED" }),
      }),
    })],
    then: ["doctor-facing identity reports master drift instead of trusting installed version", ({ ctx, result }) => {
      expect(result.ok).toBe(false);
      expect(result.issues.map((issue) => issue.code)).toContain("master-drift");
      ctx.cleanup();
    }],
  });
});
