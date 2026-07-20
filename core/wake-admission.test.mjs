import { expect, feature, unit } from "bdd-vitest";
import {
  checkWakeAdmission, localReleaseIdentity, paneNeedsWake,
} from "./wake-admission.mjs";

const SHA = "a".repeat(40);

feature("wake admission", () => {
  unit("local identity refuses a symlinked or manifest-less install", {
    then: ["classified reasons, never a pass", () => {
      expect(localReleaseIdentity({
        runtimeRoot: "/pkg",
        lstat: () => ({ isSymbolicLink: () => true }),
      })).toMatchObject({ ok: false, reason: "linked-checkout" });
      expect(localReleaseIdentity({
        runtimeRoot: "/missing",
        lstat: () => { throw new Error("ENOENT"); },
      })).toMatchObject({ ok: false, reason: "runtime-missing" });
      expect(localReleaseIdentity({
        runtimeRoot: "/pkg",
        lstat: () => ({ isSymbolicLink: () => false }),
        readJson: () => { throw new Error("ENOENT"); },
      })).toMatchObject({ ok: false, reason: "manifest" });
    }],
  });

  unit("local identity accepts matching manifest and receipt", {
    then: ["ok with the pinned sourceSha", () => {
      const files = {
        "/pkg/.agentmux-release.json": { schemaVersion: 1, sourceSha: SHA },
        ["/home/u/.agentmux/release-receipt.json"]: { schemaVersion: 1, sourceSha: SHA },
      };
      expect(localReleaseIdentity({
        runtimeRoot: "/pkg",
        home: "/home/u",
        lstat: () => ({ isSymbolicLink: () => false }),
        readJson: (path) => {
          if (!files[path]) throw new Error("ENOENT");
          return files[path];
        },
      })).toMatchObject({ ok: true, sourceSha: SHA });
    }],
  });

  unit("identity failure classifies before memory is even consulted", {
    then: ["identity-manifest beats everything", () => {
      expect(checkWakeAdmission({
        identity: { ok: false, reason: "manifest" },
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
        identity: { ok: true }, guardState: { ...healthy, level: "blocked" }, nowMs: 1_000, bootId: "b1",
      })).toMatchObject({ ok: false, reason: "memory-blocked" });
      expect(checkWakeAdmission({
        identity: { ok: true }, guardState: null, nowMs: 1_000, bootId: "b1",
      })).toMatchObject({ ok: false, reason: "guard-state-stale" });
      expect(checkWakeAdmission({
        identity: { ok: true }, guardState: healthy, nowMs: 1_000, bootId: "b1",
      })).toMatchObject({ ok: true });
      expect(checkWakeAdmission({
        identity: { ok: false, reason: "manifest" }, guardState: null, automatic: false,
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
