import { expect, feature, unit } from "bdd-vitest";
import {
  buildRestartReadiness,
  calculateFleetGeneration,
  verifyRestartReadyReceipt,
} from "./restart-ready.mjs";

const SHA = "a".repeat(40);
const base = {
  bootId: "boot-1",
  sourceSha: SHA,
  configSha: "config-1",
  sessions: ["$1:lsrc:123"],
  panels: [{ agent: "lsrc", pane: 3, engine: "codex", state: "idle" }],
  deliveries: [],
  worktrees: [{ path: "/repo", dirty: false, operation: null }],
  auth: { codex: "observed" },
  identityOk: true,
  nowMs: 1_000_000,
};

feature("restart readiness receipts", () => {
  unit("active work, deliveries, and dirty worktrees are exact blockers", {
    then: ["no receipt is produced", () => {
      const result = buildRestartReadiness({
        ...base,
        panels: [{ agent: "lsrc", pane: 3, engine: "codex", state: "active", reason: "turn-incomplete" }],
        deliveries: [{ id: "job-1", agentName: "ai", pane: 5, status: "submitted" }],
        worktrees: [{ path: "/repo", dirty: true, operation: "rebase" }],
      });
      expect(result.ready).toBe(false);
      expect(result.receipt).toBeUndefined();
      expect(result.blockers).toEqual([
        { kind: "panel", id: "lsrc:3", reason: "turn-incomplete" },
        { kind: "delivery", id: "job-1", reason: "submitted" },
        { kind: "worktree", id: "/repo", reason: "dirty" },
        { kind: "worktree", id: "/repo", reason: "rebase" },
      ]);
    }],
  });

  unit("a clean inventory produces a boot and generation bound receipt", {
    then: ["fresh exact verification passes", () => {
      const result = buildRestartReadiness(base);
      expect(result.ready).toBe(true);
      expect(result.receipt).toMatchObject({
        schemaVersion: 1,
        ready: true,
        bootId: "boot-1",
        sourceSha: SHA,
        createdAtMs: 1_000_000,
        expiresAtMs: 1_600_000,
      });
      expect(result.receipt.fleetGeneration).toBe(calculateFleetGeneration(base));
      expect(verifyRestartReadyReceipt(result.receipt, {
        receiptId: result.receipt.receiptId,
        bootId: "boot-1",
        fleetGeneration: result.receipt.fleetGeneration,
        sourceSha: SHA,
        nowMs: 1_100_000,
      })).toEqual({ allow: true, reason: "ok" });
    }],
  });

  unit("stale, wrong-boot, wrong-generation, and wrong-source receipts refuse", {
    then: ["each boundary has one classified reason", () => {
      const receipt = buildRestartReadiness(base).receipt;
      expect(verifyRestartReadyReceipt(receipt, {
        bootId: "boot-1", fleetGeneration: receipt.fleetGeneration, sourceSha: SHA, nowMs: 1_700_000,
      }).reason).toBe("restart-ready-receipt-stale");
      expect(verifyRestartReadyReceipt(receipt, {
        bootId: "boot-2", fleetGeneration: receipt.fleetGeneration, sourceSha: SHA, nowMs: 1_100_000,
      }).reason).toBe("restart-ready-receipt-boot");
      expect(verifyRestartReadyReceipt(receipt, {
        bootId: "boot-1", fleetGeneration: "other", sourceSha: SHA, nowMs: 1_100_000,
      }).reason).toBe("restart-ready-receipt-generation");
      expect(verifyRestartReadyReceipt(receipt, {
        bootId: "boot-1", fleetGeneration: receipt.fleetGeneration, sourceSha: "b".repeat(40), nowMs: 1_100_000,
      }).reason).toBe("restart-ready-receipt-source");
    }],
  });
});
