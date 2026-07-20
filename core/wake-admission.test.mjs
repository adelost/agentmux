import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, feature, unit } from "bdd-vitest";
import {
  checkWakeAdmission, observeWakeIdentity, paneNeedsWake,
} from "./wake-admission.mjs";
import { identityDecision, observeReleaseIdentity } from "./release-identity.mjs";

const SHA = "a".repeat(40);
const ARTIFACT_SHA = "b".repeat(64);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// A full local identity fixture: package + receipt + hooks + settings, with
// ONE controllable package byte. Remote master is offline (warn, not block).
function identityFixture({ packageBytes = "original-bytes\n", manifestBytes = "original-bytes\n" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "amux-wake-id-"));
  const home = join(base, "home");
  const pkg = join(base, "pkg");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  mkdirSync(join(pkg, "core"), { recursive: true });
  mkdirSync(join(home, ".agentmux", "hooks"), { recursive: true });
  mkdirSync(join(home, ".claude"), { recursive: true });

  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "agentmux", version: "1.0.0" })}\n`);
  writeFileSync(join(pkg, "core", "a.mjs"), packageBytes);
  writeFileSync(join(pkg, "bin", "agent-cli.mjs"), "#!/usr/bin/env node\n");
  const hookFiles = {
    eventHook: join(pkg, "bin", "amux-hook.mjs"),
    suggestionsGuard: join(home, ".agentmux", "hooks", "suggestions-write-guard.mjs"),
    suggestionsClient: join(home, ".agentmux", "bin", "amux-suggest.mjs"),
    suggestionsCore: join(home, ".agentmux", "core", "suggestions-authoring.mjs"),
  };
  mkdirSync(join(home, ".agentmux", "bin"), { recursive: true });
  mkdirSync(join(home, ".agentmux", "core"), { recursive: true });
  writeFileSync(hookFiles.eventHook, "// hook\n");
  writeFileSync(hookFiles.suggestionsGuard, "// guard\n");
  writeFileSync(hookFiles.suggestionsClient, "// client\n");
  writeFileSync(hookFiles.suggestionsCore, "// core\n");

  const packageRoot = realpathSync(pkg);
  const entryPath = join(pkg, "bin", "agent-cli.mjs");
  writeFileSync(join(pkg, ".agentmux-release.json"), `${JSON.stringify({
    schemaVersion: 1,
    sourceSha: SHA,
    packageVersion: "1.0.0",
    files: { "core/a.mjs": sha256(manifestBytes) },
  })}\n`);
  writeFileSync(join(home, ".agentmux", "release-receipt.json"), `${JSON.stringify({
    schemaVersion: 1,
    sourceSha: SHA,
    packageVersion: "1.0.0",
    artifactSha256: ARTIFACT_SHA,
    packageRoot,
    binaryRealpath: realpathSync(entryPath),
    hooks: Object.fromEntries(Object.entries(hookFiles).map(([key, path]) => [key, {
      path,
      sha256: sha256(path === hookFiles.eventHook ? "// hook\n"
        : path === hookFiles.suggestionsGuard ? "// guard\n"
          : path === hookFiles.suggestionsClient ? "// client\n" : "// core\n"),
      ...(key === "suggestionsGuard" ? { inlineMutationBlocked: true } : {}),
    }])),
  })}\n`);
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({
    hooks: Object.fromEntries([
      ...["Stop", "Notification", "UserPromptSubmit", "SessionStart"].map((event) => [event, [
        { hooks: [{ command: `exec node "${hookFiles.eventHook}"` }] },
      ]]),
      ["PreToolUse", [{ hooks: [{ command: `exec node "${hookFiles.suggestionsGuard}"` }] }]],
    ]),
  }));
  const observe = () => observeReleaseIdentity({
    runtimeRoot: pkg,
    entryPath,
    home,
    runGuardCanary: () => ({ status: 2, stderr: "BLOCKED" }),
    readRemoteMaster: () => { throw new Error("offline"); },
  });
  return { base, observe, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

feature("wake admission", () => {
  unit("a valid installed release passes the single identity contract", {
    given: ["aligned manifest, bytes, receipt, hooks", () => identityFixture()],
    when: ["observing identity", (fx) => {
      const identity = fx.observe();
      return { fx, identity };
    }],
    then: ["allowRevive with only an offline warning", ({ fx, identity }) => {
      expect(identity.ok).toBe(true);
      expect(identityDecision(identity)).toMatchObject({ allowBridge: true, allowRevive: true, reason: "ok" });
      fx.cleanup();
    }],
  });

  unit("matching SHA but one tampered package byte refuses the wake before any pane write", {
    given: ["manifest lists original bytes but the package file is tampered", () => identityFixture({
      packageBytes: "tampered-bytes\n",
      manifestBytes: "original-bytes\n",
    })],
    when: ["observing identity and consulting wake admission", (fx) => {
      const identity = identityDecision(fx.observe());
      const verdict = checkWakeAdmission({ identity, guardState: null, automatic: true });
      return { fx, identity, verdict };
    }],
    then: ["package-content issue, allowRevive false, wake refused classified", ({ fx, identity, verdict }) => {
      expect(identity.allowRevive).toBe(false);
      expect(identity.reason).toBe("package-content");
      expect(verdict).toMatchObject({ ok: false, reason: "identity-package-content" });
      fx.cleanup();
    }],
  });

  unit("observeWakeIdentity maps through the same contract and never calls remote", {
    given: ["a stubbed observation", () => {
      const identity = observeWakeIdentity({
        runtimeRoot: "/pkg",
        entryPath: "/bin/amux",
        observe: () => ({ ok: true, sourceSha: SHA, packageVersion: "1.0.0", issues: [], warnings: [] }),
      });
      return identity;
    }],
    when: ["reading the decision", (identity) => identity],
    then: ["allowRevive true", (identity) => {
      expect(identity).toMatchObject({ allowBridge: true, allowRevive: true, reason: "ok" });
    }],
  });

  unit("identity failure classifies before memory is even consulted", {
    then: ["identity-manifest beats everything", () => {
      expect(checkWakeAdmission({
        identity: { allowRevive: false, reason: "manifest" },
        guardState: { bootId: "b1", observedAt: 900, level: "normal" },
        nowMs: 1_000,
        bootId: "b1",
      })).toMatchObject({ ok: false, reason: "identity-manifest" });
    }],
  });

  unit("memory-blocked or stale guard refuses the wake; healthy passes; manual overrides", {
    then: ["each lane classified", () => {
      const healthy = {
        bootId: "b1",
        observedAt: 1_000,
        level: "normal",
        sample: {
          memTotalKb: 48 * 1024 * 1024,
          memAvailableKb: 20 * 1024 * 1024,
          swapTotalKb: 4 * 1024 * 1024,
          swapFreeKb: 4 * 1024 * 1024,
        },
      };
      expect(checkWakeAdmission({
        identity: { allowRevive: true }, guardState: { ...healthy, level: "blocked" }, nowMs: 1_000, bootId: "b1",
      })).toMatchObject({ ok: false, reason: "memory-blocked" });
      expect(checkWakeAdmission({
        identity: { allowRevive: true }, guardState: null, nowMs: 1_000, bootId: "b1",
      })).toMatchObject({ ok: false, reason: "guard-state-stale" });
      expect(checkWakeAdmission({
        identity: { allowRevive: true }, guardState: healthy, nowMs: 1_000, bootId: "b1",
      })).toMatchObject({ ok: true });
      expect(checkWakeAdmission({
        identity: { allowRevive: false, reason: "manifest" }, guardState: null, automatic: false,
      })).toMatchObject({ ok: true, reason: "manual-override" });
    }],
  });

  unit("a live agent process never needs a wake", {
    then: ["running stays delivery, stopped/shell/dead is a wake", () => {
      expect(paneNeedsWake({ command: "kimi-code", shell: false, running: true })).toBe(false);
      expect(paneNeedsWake({ command: "bash", shell: true, running: false })).toBe(true);
      expect(paneNeedsWake({ command: null, dead: true, running: false })).toBe(true);
      expect(paneNeedsWake(null)).toBe(true);
    }],
  });
});
