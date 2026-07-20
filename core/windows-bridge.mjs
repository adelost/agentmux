// Windows rescue bridge contract: one versioned command/state truth for the
// thin PowerShell poller. All decisions live here so they are vitest-able;
// the ps1 only does Discord I/O, process spawning, and scheduling.

/** WHAT: Names the current contract version for the Windows bridge. WHY: Keeps poller and logic on one explicit contract. */
export const WINDOWS_BRIDGE_CONTRACT_VERSION = 1;

/** WHAT: Defines the accepted bridge commands. WHY: Prevents arbitrary text from becoming an action. */
export const COMMANDS = Object.freeze([
  "status",
  "logs",
  "start-wsl",
  "start-bridge",
  "recover",
  "restart",
  "restart-wsl",
  "hardrestart",
]);

const READ_ONLY = new Set(["status", "logs"]);
const RECEIPT_PATTERN = /^[0-9a-f]{8,64}$/u;

/** WHAT: Parses one Discord message into a bridge command. WHY: Keeps only exact allowlisted commands actionable. */
export function parseBridgeCommand(text) {
  const trimmed = String(text || "").trim().toLowerCase();
  if (!trimmed.startsWith("//")) return null;
  const parts = trimmed.slice(2).split(/\s+/u).filter(Boolean);
  const command = parts[0];
  if (!COMMANDS.includes(command)) return null;
  const args = {};
  if (command === "restart-wsl") {
    if (parts.length === 1) return { command, args };
    if (parts.length === 3 && parts[1] === "--receipt" && RECEIPT_PATTERN.test(parts[2])) {
      args.receipt = parts[2];
      return { command, args };
    }
    return null;
  }
  if (parts.length !== 1) return null;
  return { command, args };
}

/** WHAT: Checks whether a destructive command may run. WHY: Prevents a destructive restart without a fresh restart-ready receipt. */
export function destructiveVerdict({
  command,
  restartReadyReceipt = null,
  nowMs = Date.now(),
  generation = null,
  ttlMs = 15 * 60_000,
} = {}) {
  if (command !== "hardrestart" && command !== "restart-wsl") {
    return { allow: true, reason: "not-destructive" };
  }
  if (!restartReadyReceipt) return { allow: false, reason: "restart-ready-receipt-missing" };
  const createdAtMs = Number(restartReadyReceipt.createdAtMs);
  if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs || nowMs - createdAtMs > ttlMs) {
    return { allow: false, reason: "restart-ready-receipt-stale" };
  }
  if (generation && restartReadyReceipt.generation !== generation) {
    return { allow: false, reason: "restart-ready-receipt-generation" };
  }
  return { allow: true, reason: "ok" };
}

/** WHAT: Maps stage results to one recovery outcome. WHY: Keeps RECOVERED/PARTIAL/BLOCKED honest about what ran. */
export function classifyRecovery(stages = []) {
  const succeeded = stages.filter((stage) => stage.ok);
  if (succeeded.length === stages.length && stages.length > 0) {
    return { outcome: "RECOVERED", failedStage: null };
  }
  if (succeeded.length > 0) {
    return { outcome: "PARTIAL", failedStage: stages.find((stage) => !stage.ok)?.stage || null };
  }
  return { outcome: "BLOCKED", failedStage: stages.find((stage) => !stage.ok)?.stage || null };
}

/** WHAT: Builds the durable journal entry for an accepted command. WHY: Keeps a crash from silently losing the command. */
export function planAcceptedAction({ messageId, command, generation, nowMs = Date.now() }) {
  return {
    schemaVersion: 1,
    messageId: String(messageId),
    command,
    generation,
    status: "started",
    startedAt: new Date(nowMs).toISOString(),
  };
}

/** WHAT: Maps a crash-leftover action to its resume disposition. WHY: Prevents a destructive action from ever retrying ambiguously. */
export function resumeLeftoverAction(action) {
  if (!action || action.status !== "started") {
    return { disposition: "retry-read", reason: "no-leftover" };
  }
  if (READ_ONLY.has(action.command)) {
    return { disposition: "retry-read", reason: "read-only-idempotent" };
  }
  return { disposition: "blocked", reason: "crashed-mid-action" };
}
