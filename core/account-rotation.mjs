// Pure policy for subscription-account rotation.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { externalClaudeMdImports } from "./claude-md-imports.mjs";

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
// were rolled back. Claude Code asks once per profile and project; the source profile's answer does not carry over.
// 2026-11-03: the check held all 22 panes on Claude S, 16 of them for a question that never comes. Claude Code 2.1.312
// saves the answer under the project root (the git root, else the directory) and asks only when a CLAUDE.md imports a
// file from outside the directory; the old check read projects[pane directory] and took the source's old approval as
// proof that a question exists.
// Current Claude Code saves the answers under the git root, older versions under the directory itself. A linked worktree counts as its own root.
/** WHAT: Names the project keys a directory's start answers may be saved under. WHY: Keeps a current answer under the git root from being missed by reading only the pane directory. */
export function claudeStartAnswerKeys(cwd, hasGitEntry = dir => existsSync(join(dir, ".git"))) {
  const keys = [cwd];
  for (let dir = cwd; dir !== dirname(dir); dir = dirname(dir)) {
    if (hasGitEntry(dir)) {
      if (dir !== cwd) keys.push(dir);
      break;
    }
  }
  return keys;
}

/** WHAT: Names the start question the target profile would ask for a pane directory. WHY: Keeps a pane from restarting into an open question, and from being held for one never asked. */
export function claudeStartDialog({ target, cwd, readJson, hasGitEntry, externalImports = externalClaudeMdImports }) {
  const projects = readJson(target?.identityPath)?.projects || {};
  const answered = claudeStartAnswerKeys(cwd, hasGitEntry).some(key =>
    projects[key]?.hasClaudeMdExternalIncludesApproved === true || projects[key]?.hasClaudeMdExternalIncludesWarningShown === true);
  return !answered && externalImports(cwd).length > 0 ? "external-claude-md-imports" : null;
}
