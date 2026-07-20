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
  receiptId = null,
  bootId = null,
  fleetGeneration = null,
  sourceSha = null,
} = {}) {
  if (command !== "hardrestart" && command !== "restart-wsl") {
    return { allow: true, reason: "not-destructive" };
  }
  if (!restartReadyReceipt) return { allow: false, reason: "restart-ready-receipt-missing" };
  if (restartReadyReceipt.ready !== true
    || restartReadyReceipt.receiptId !== receiptId
    || !Number.isFinite(restartReadyReceipt.createdAtMs)
    || !Number.isFinite(restartReadyReceipt.expiresAtMs)
    || restartReadyReceipt.createdAtMs > nowMs
    || restartReadyReceipt.expiresAtMs < nowMs) {
    return { allow: false, reason: "restart-ready-receipt-stale" };
  }
  if (bootId && restartReadyReceipt.bootId !== bootId) {
    return { allow: false, reason: "restart-ready-receipt-boot" };
  }
  if (fleetGeneration && restartReadyReceipt.fleetGeneration !== fleetGeneration) {
    return { allow: false, reason: "restart-ready-receipt-generation" };
  }
  if (sourceSha && restartReadyReceipt.sourceSha !== sourceSha) {
    return { allow: false, reason: "restart-ready-receipt-source" };
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

/** WHAT: Builds one authorized Discord-message plan through the shared parser. WHY: Keeps PowerShell from maintaining a second command allowlist. */
export function planDiscordMessage({
  messageId,
  text,
  generation,
  nowMs = Date.now(),
} = {}) {
  const parsed = parseBridgeCommand(text);
  if (!parsed) return { accepted: false, reason: "not-command" };
  return {
    accepted: true,
    parsed,
    action: planAcceptedAction({
      messageId,
      command: parsed.command,
      generation,
      nowMs,
    }),
  };
}

/** WHAT: Maps a state journal after process restart. WHY: Prevents the exact ambiguous non-read message from executing twice. */
export function reconcileInterruptedState(state, { nowMs = Date.now() } = {}) {
  const next = structuredClone(state || {});
  const action = next.lastAction;
  const resume = resumeLeftoverAction(action);
  if (resume.disposition !== "blocked") {
    return { state: next, ...resume };
  }
  action.status = "blocked";
  action.completedAt = new Date(nowMs).toISOString();
  action.stage = resume.reason;
  next.lastAction = action;
  next.lastSeenId = String(action.messageId);
  return {
    state: next,
    disposition: "blocked",
    reason: resume.reason,
    fencedMessageId: String(action.messageId),
  };
}

/** WHAT: Maps one bounded WSL observation for the Windows control plane. WHY: Keeps health meaning out of the PowerShell transport. */
export function classifyWindowsObservation(observation) {
  if (!observation?.wslReachable) {
    return {
      outcome: "PARTIAL",
      reason: observation?.timedOut ? "wsl-timeout" : "wsl-offline",
      nextStep: "start-wsl",
    };
  }
  const bridgeState = observation.bridge?.state || "missing";
  if (bridgeState === "hung" || bridgeState === "stale-code") {
    return { outcome: "BLOCKED", reason: `bridge-${bridgeState}`, nextStep: "none" };
  }
  if (bridgeState !== "ok") {
    return { outcome: "PARTIAL", reason: `bridge-${bridgeState}`, nextStep: "start-bridge" };
  }
  if (!observation.release?.allowRevive) {
    return {
      outcome: "PARTIAL",
      reason: `release-${observation.release?.reason || "unverified"}`,
      nextStep: "none",
    };
  }
  if (observation.memory?.stale) {
    return { outcome: "PARTIAL", reason: "memory-state-stale", nextStep: "none" };
  }
  if (["blocked", "critical"].includes(observation.memory?.level)) {
    return {
      outcome: "PARTIAL",
      reason: `memory-${observation.memory.level}`,
      nextStep: "none",
    };
  }
  return { outcome: "READY", reason: "ok", nextStep: "none" };
}

/** WHAT: Formats one bounded observation without secrets or raw process output. WHY: Keeps Discord status concise and deterministic. */
export function formatWindowsStatus(observation) {
  const verdict = classifyWindowsObservation(observation);
  const bridge = observation?.bridge?.state || "unknown";
  const release = observation?.release?.allowRevive
    ? `ok:${String(observation.release.sourceSha || "unknown").slice(0, 12)}`
    : `blocked:${observation?.release?.reason || "unverified"}`;
  const memory = observation?.memory?.stale
    ? "stale"
    : (observation?.memory?.level || "unknown");
  return [
    `AMUX ${verdict.outcome} reason=${verdict.reason}`,
    `windows=online wsl=${observation?.wslReachable ? "online" : "offline"} boot=${observation?.bootId || "unknown"}`,
    `bridge=${bridge} release=${release} memory=${memory}`,
  ].join("\n");
}
