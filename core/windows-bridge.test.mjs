import { expect, feature, unit } from "bdd-vitest";
import {
  COMMANDS,
  classifyRecovery,
  classifyWindowsObservation,
  destructiveVerdict,
  formatWindowsStatus,
  parseBridgeCommand,
  planAcceptedAction,
  planDiscordMessage,
  reconcileInterruptedState,
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
        restartReadyReceipt: {
          ready: true,
          receiptId: "r1",
          createdAtMs: nowMs - 20_000,
          expiresAtMs: nowMs - 1,
        },
        nowMs,
      })).toEqual({ allow: false, reason: "restart-ready-receipt-stale" });
      expect(destructiveVerdict({
        command: "restart-wsl",
        restartReadyReceipt: {
          ready: true,
          receiptId: "r1",
          bootId: "b1",
          fleetGeneration: "g1",
          sourceSha: "s1",
          createdAtMs: nowMs - 1_000,
          expiresAtMs: nowMs + 1_000,
        },
        nowMs,
        receiptId: "r1",
        bootId: "b1",
        fleetGeneration: "g2",
        sourceSha: "s1",
      })).toEqual({ allow: false, reason: "restart-ready-receipt-generation" });
      expect(destructiveVerdict({
        command: "restart-wsl",
        restartReadyReceipt: {
          ready: true,
          receiptId: "r1",
          bootId: "b1",
          fleetGeneration: "g1",
          sourceSha: "s1",
          createdAtMs: nowMs - 1_000,
          expiresAtMs: nowMs + 1_000,
        },
        nowMs,
        receiptId: "r1",
        bootId: "b1",
        fleetGeneration: "g1",
        sourceSha: "s1",
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

  unit("PowerShell receives its command decision from the shared parser", {
    then: ["accepted messages carry parsed arguments and the durable action", () => {
      expect(planDiscordMessage({
        messageId: "777",
        text: "//restart-wsl --receipt ab12cd34",
        generation: "g7",
        nowMs: 2_000,
      })).toEqual({
        accepted: true,
        parsed: { command: "restart-wsl", args: { receipt: "ab12cd34" } },
        action: {
          schemaVersion: 1,
          messageId: "777",
          command: "restart-wsl",
          generation: "g7",
          status: "started",
          startedAt: new Date(2_000).toISOString(),
        },
      });
      expect(planDiscordMessage({ messageId: "778", text: "//unknown", generation: "g7" }))
        .toEqual({ accepted: false, reason: "not-command" });
    }],
  });

  unit("restart reconciliation fences an ambiguous non-read message permanently", {
    then: ["the action is BLOCKED and the Discord cursor advances to that exact message", () => {
      const result = reconcileInterruptedState({
        schemaVersion: 1,
        lastSeenId: "776",
        lastAction: {
          schemaVersion: 1,
          messageId: "777",
          command: "recover",
          generation: "g7",
          status: "started",
          startedAt: new Date(1_000).toISOString(),
        },
      }, { nowMs: 3_000 });
      expect(result).toMatchObject({
        disposition: "blocked",
        reason: "crashed-mid-action",
        fencedMessageId: "777",
        state: {
          lastSeenId: "777",
          lastAction: {
            status: "blocked",
            stage: "crashed-mid-action",
            completedAt: new Date(3_000).toISOString(),
          },
        },
      });
    }],
  });

  unit("status distinguishes offline, hung, recoverable, and healthy WSL states", {
    then: ["only missing WSL or bridge gets a safe start step", () => {
      expect(classifyWindowsObservation({ wslReachable: false, timedOut: true }))
        .toEqual({ outcome: "PARTIAL", reason: "wsl-timeout", nextStep: "start-wsl" });
      expect(classifyWindowsObservation({
        wslReachable: true,
        bridge: { state: "missing" },
      })).toEqual({ outcome: "PARTIAL", reason: "bridge-missing", nextStep: "start-bridge" });
      expect(classifyWindowsObservation({
        wslReachable: true,
        bridge: { state: "hung" },
      })).toEqual({ outcome: "BLOCKED", reason: "bridge-hung", nextStep: "none" });
      const healthy = {
        wslReachable: true,
        bootId: "boot-3",
        bridge: { state: "ok" },
        release: { allowRevive: true, sourceSha: "a".repeat(40) },
        memory: { level: "normal", stale: false },
      };
      expect(classifyWindowsObservation(healthy))
        .toEqual({ outcome: "READY", reason: "ok", nextStep: "none" });
      expect(formatWindowsStatus(healthy)).toContain("AMUX READY reason=ok");
      expect(formatWindowsStatus(healthy)).toContain("release=ok:aaaaaaaaaaaa");
    }],
  });
});
