import { expect, feature, unit } from "bdd-vitest";
import {
  COMMANDS,
  classifyRecovery,
  destructiveVerdict,
  parseBridgeCommand,
  planAcceptedAction,
  resumeLeftoverAction,
  WINDOWS_BRIDGE_CONTRACT_VERSION,
} from "./windows-bridge.mjs";

feature("windows bridge contract", () => {
  unit("parses exactly the allowlisted commands and nothing else", {
    then: ["each command maps, garbage is null", () => {
      expect(WINDOWS_BRIDGE_CONTRACT_VERSION).toBe(1);
      for (const cmd of COMMANDS) {
        expect(parseBridgeCommand(`//${cmd}`)).toEqual({ command: cmd, args: {} });
      }
      expect(parseBridgeCommand("//status extra")).toBeNull();
      expect(parseBridgeCommand("//reboot")).toBeNull();
      expect(parseBridgeCommand("status")).toBeNull();
      expect(parseBridgeCommand("//restart-wsl")).toEqual({ command: "restart-wsl", args: {} });
      expect(parseBridgeCommand("//restart-wsl --receipt ab12cd34ef56")).toEqual({
        command: "restart-wsl",
        args: { receipt: "ab12cd34ef56" },
      });
      expect(parseBridgeCommand("//restart-wsl --receipt zzz")).toBeNull();
      expect(parseBridgeCommand("//restart-wsl extra")).toBeNull();
    }],
  });

  unit("destructive commands refuse without a fresh matching receipt", {
    then: ["missing, stale and generation-mismatch all refuse with exact reasons", () => {
      const nowMs = 1_000_000;
      expect(destructiveVerdict({ command: "hardrestart", nowMs }))
        .toEqual({ allow: false, reason: "restart-ready-receipt-missing" });
      expect(destructiveVerdict({
        command: "restart-wsl",
        restartReadyReceipt: { generation: "g1", createdAtMs: nowMs - 16 * 60_000 },
        nowMs,
        generation: "g1",
      })).toEqual({ allow: false, reason: "restart-ready-receipt-stale" });
      expect(destructiveVerdict({
        command: "restart-wsl",
        restartReadyReceipt: { generation: "g1", createdAtMs: nowMs - 1_000 },
        nowMs,
        generation: "g2",
      })).toEqual({ allow: false, reason: "restart-ready-receipt-generation" });
      expect(destructiveVerdict({
        command: "restart-wsl",
        restartReadyReceipt: { generation: "g1", createdAtMs: nowMs - 1_000 },
        nowMs,
        generation: "g1",
      })).toEqual({ allow: true, reason: "ok" });
      expect(destructiveVerdict({ command: "status" })).toEqual({ allow: true, reason: "not-destructive" });
    }],
  });

  unit("recovery outcomes classify exactly", {
    then: ["RECOVERED, PARTIAL, BLOCKED", () => {
      expect(classifyRecovery([{ stage: "wsl", ok: true }, { stage: "bridge", ok: true }]))
        .toEqual({ outcome: "RECOVERED", failedStage: null });
      expect(classifyRecovery([{ stage: "wsl", ok: true }, { stage: "bridge", ok: false }]))
        .toEqual({ outcome: "PARTIAL", failedStage: "bridge" });
      expect(classifyRecovery([{ stage: "wsl", ok: false }, { stage: "bridge", ok: false }]))
        .toEqual({ outcome: "BLOCKED", failedStage: "wsl" });
    }],
  });

  unit("an accepted action journals before execution with its generation", {
    then: ["the entry carries message, command, generation and started state", () => {
      const entry = planAcceptedAction({ messageId: "123", command: "restart", generation: "g9", nowMs: 1_000 });
      expect(entry).toMatchObject({
        schemaVersion: 1,
        messageId: "123",
        command: "restart",
        generation: "g9",
        status: "started",
      });
      expect(entry.startedAt).toBe(new Date(1_000).toISOString());
    }],
  });

  unit("a crash-leftover action resumes read-only but never destructive", {
    then: ["status resumes, restart is blocked crashed-mid-action", () => {
      expect(resumeLeftoverAction({ command: "status", status: "started" }))
        .toEqual({ disposition: "retry-read", reason: "read-only-idempotent" });
      expect(resumeLeftoverAction({ command: "restart", status: "started" }))
        .toEqual({ disposition: "blocked", reason: "crashed-mid-action" });
      expect(resumeLeftoverAction({ command: "hardrestart", status: "started" }))
        .toEqual({ disposition: "blocked", reason: "crashed-mid-action" });
      expect(resumeLeftoverAction(null))
        .toEqual({ disposition: "retry-read", reason: "no-leftover" });
      expect(resumeLeftoverAction({ command: "restart", status: "completed" }))
        .toEqual({ disposition: "retry-read", reason: "no-leftover" });
    }],
  });
});
