// Pure policy for subscription-account rotation.

const SHELL_COMMAND = /^(?:bash|zsh|sh|fish|dash)$/u;

/** WHAT: Maps one configured Claude pane to a rotation mode. WHY: Prevents ambiguous context or process truth from authorizing rotation. */
export function classifyClaudeRotationPane({
  processState,
  busy,
  transportState,
  liveDeliveryJobs,
  sessionId,
} = {}) {
  if (!processState || processState.dead || !processState.command) {
    return { allow: true, mode: "dormant", reason: "pane-offline" };
  }
  if (processState.shell || SHELL_COMMAND.test(processState.command)) {
    return { allow: true, mode: "dormant", reason: "pane-sleeping" };
  }
  if (processState.running !== true) {
    return { allow: false, mode: "blocked", reason: "unexpected-pane-process" };
  }
  if (busy !== false) {
    return { allow: false, mode: "blocked", reason: "active-or-unknown-turn" };
  }
  if (transportState !== "empty-idle") {
    return { allow: false, mode: "blocked", reason: "composer-not-provably-empty" };
  }
  if (Number(liveDeliveryJobs) !== 0) {
    return { allow: false, mode: "blocked", reason: "live-or-unknown-delivery" };
  }
  if (!sessionId) {
    return { allow: false, mode: "blocked", reason: "exact-session-missing" };
  }
  return { allow: true, mode: "running", reason: "ready" };
}

/** WHAT: Reports the fleet result from per-pane outcomes. WHY: Keeps partial recovery from being upgraded to success. */
export function accountRotationOutcome(rows = []) {
  const failed = rows.filter((row) => row.status === "failed");
  const rolledBack = rows.filter((row) => row.status === "rolled-back");
  if (failed.length) return { status: "BLOCKED", failed, rolledBack };
  if (rolledBack.length) return { status: "PARTIAL", failed, rolledBack };
  return { status: "RECOVERED", failed, rolledBack };
}
