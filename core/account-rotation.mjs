// Pure policy for subscription-account rotation.

const SHELL_COMMAND = /^(?:bash|zsh|sh|fish|dash)$/u;

/** WHAT: Maps one configured Claude pane to a rotation mode. WHY: Prevents ambiguous context or process truth from authorizing rotation. */
export function classifyClaudeRotationPane({
  processState,
  busy,
  transportState,
  liveDeliveryJobs,
  sessionId,
  quotaStopped = false,
} = {}) {
  if (Number(liveDeliveryJobs) !== 0) {
    return { allow: false, mode: "blocked", reason: "live-or-unknown-delivery" };
  }
  // A pane stopped at its limit cannot answer, so its composer and turn prove
  // nothing; quota recovery owns its exact-session restart on the new account.
  if (quotaStopped) return { allow: true, mode: "quota-stopped", reason: "limit-receipt" };
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
  if (!sessionId) {
    return { allow: false, mode: "blocked", reason: "exact-session-missing" };
  }
  return { allow: true, mode: "running", reason: "ready" };
}

/** WHAT: Reports the fleet result from per-pane outcomes. WHY: Keeps partial recovery from being upgraded to success. */
export function accountRotationOutcome(rows = []) {
  const failed = rows.filter((row) => row.status === "failed" || row.status === "blocked");
  const rolledBack = rows.filter((row) => row.status === "rolled-back");
  const available = rows.some((row) => row.status === "switched"
    || row.status === "selected-for-next-wake"
    || row.status === "selected-for-quota-recovery"
    || row.status === "already-selected"
    || row.status.startsWith("would-"));
  if (failed.length || rolledBack.length) {
    return { status: available ? "PARTIAL" : "BLOCKED", failed, rolledBack };
  }
  return { status: "RECOVERED", failed, rolledBack };
}

// 2026-10-21 03:52Z: four panes moved to Claude A waited 120 s each on "Allow external CLAUDE.md file imports?" and
// were rolled back. Claude Code asks once per profile and directory; the source profile's answer does not carry over.
/** WHAT: Names a start dialog the target profile would show in a directory the source profile already settled. WHY: Keeps a move from restarting a pane into a dialog nobody answers. */
export function claudeStartDialog({ source, target, cwd, readJson }) {
  const project = profile => readJson(profile?.identityPath)?.projects?.[cwd] || {};
  const before = project(source), after = project(target);
  return before.hasClaudeMdExternalIncludesApproved === true && after.hasClaudeMdExternalIncludesApproved !== true
    && after.hasClaudeMdExternalIncludesWarningShown !== true ? "external-claude-md-imports" : null;
}
