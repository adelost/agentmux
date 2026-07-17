// Exact-session process boundary for the quota recovery sidecar.

import { appendEvent } from "./events.mjs";
import { buildClaudeLaunchCommand } from "./agent-launch-command.mjs";
import { createTmuxAdapter } from "./tmux.mjs";
import { findBlockingPrompt } from "./dismiss.mjs";
import { persistedSessionIdentity } from "./native-session-identity.mjs";
import {
  activeClaudeLimitForTarget,
  configuredClaudeTarget,
} from "./claude-quota-target.mjs";

const SHELL_PROCESS = /^(bash|zsh|fish|sh|dash)$/u;
const CLAUDE_PROCESS = /^(claude|node)$/u;

function sameReceipt(left, right) {
  return Boolean(left && right
    && left.sessionId === right.sessionId
    && left.limitEventId === right.limitEventId);
}

function hasEmptyClaudeComposer(screen) {
  return String(screen || "").split("\n")
    .some((line) => /^\s*❯\s*$/u.test(line));
}

function hasExactResumeLaunch(screen, sessionId) {
  if (!sessionId) return false;
  const escaped = String(sessionId).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`--resume\\s+['\"]?${escaped}['\"]?(?:\\s|$)`, "u")
    .test(String(screen || ""));
}

/**
 * WHAT: Routes the destructive tmux boundary for exact-session Claude recovery.
 * WHY: Keeps quota polling separate from process identity and manual-draft guards.
 */
export function createClaudeQuotaLifecycle({
  configPath,
  tmuxSocket,
  tmuxExec,
  homeDir = process.env.HOME,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  record = appendEvent,
} = {}) {
  if (!configPath) throw new Error("Claude quota lifecycle requires configPath");
  if (!tmuxSocket || typeof tmuxExec !== "function") {
    throw new Error("Claude quota lifecycle requires tmux transport");
  }
  const tmux = createTmuxAdapter({ socket: tmuxSocket, exec: tmuxExec });
  const activeReceipt = (agentName, pane) => activeClaudeLimitForTarget(agentName, pane, {
    configPath,
    homeDir,
  });

  async function waitForShell(target) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const command = await tmux.currentCommand(target).catch(() => "");
      if (SHELL_PROCESS.test(command)) return true;
      await delay(100);
    }
    return false;
  }

  async function waitForComposer(target) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const [command, screen] = await Promise.all([
        tmux.currentCommand(target).catch(() => ""),
        tmux.captureScreen(target).catch(() => ""),
      ]);
      const blocker = findBlockingPrompt(screen);
      if (blocker) {
        await tmux.sendKeys(target, blocker.keys).catch(() => {});
        await delay(blocker.waitMs);
        continue;
      }
      if (CLAUDE_PROCESS.test(command) && hasEmptyClaudeComposer(screen)) return true;
      await delay(100);
    }
    return false;
  }

  /**
   * WHAT: Replaces one limited pane and resumes only its receipt-bound session.
   * WHY: Prevents stale observations from killing a manual recovery or starting fresh.
   */
  async function restart(agentName, pane, expectedReceipt) {
    const targetConfig = configuredClaudeTarget(agentName, pane, { configPath });
    if (!targetConfig) return { ok: false, reason: "not-a-tmux-claude-target" };
    if (!expectedReceipt?.sessionId || !expectedReceipt?.limitEventId) {
      return { ok: false, reason: "missing-exact-limit-receipt" };
    }
    const persisted = persistedSessionIdentity(
      "claude",
      expectedReceipt.sessionId,
      targetConfig.cwd,
      { homeDir },
    );
    if (!persisted) return { ok: false, reason: "session-not-owned-by-pane" };
    if (!sameReceipt(activeReceipt(agentName, pane), expectedReceipt)) {
      return { ok: false, reason: "limit-receipt-superseded" };
    }

    const target = `${agentName}:.${Number(pane) || 0}`;
    const [command, screen] = await Promise.all([
      tmux.currentCommand(target).catch(() => ""),
      tmux.captureScreen(target).catch(() => ""),
    ]);
    if (CLAUDE_PROCESS.test(command) && !hasEmptyClaudeComposer(screen)) {
      const blocker = findBlockingPrompt(screen);
      const recentHistory = blocker?.name === "resume"
        ? await tmux.capture(target, { lines: 80 }).catch(() => "")
        : "";
      const pendingExactResume = blocker?.name === "resume"
        && hasExactResumeLaunch(recentHistory, expectedReceipt.sessionId);
      if (!pendingExactResume) {
        return { ok: false, reason: "pane-has-no-empty-claude-composer" };
      }
      // A prior recovery attempt can survive while the sidecar/bridge restarts.
      // Finish only a screen-proven resume of this exact receipt-bound session;
      // an unrelated manual resume menu remains fail-closed above.
      if (!await waitForComposer(target)) {
        return { ok: false, reason: "pending-exact-resume-composer-not-ready" };
      }
      if (!sameReceipt(activeReceipt(agentName, pane), expectedReceipt)) {
        return { ok: false, reason: "limit-receipt-superseded" };
      }
      try {
        record({
          ts: new Date().toISOString(),
          event: "quota_recovery",
          session: agentName,
          pane: Number(pane) || 0,
          state: "resumed_pending_exact",
          detail: expectedReceipt.sessionId,
        });
      } catch { /* diagnostics never invalidate a successful process boundary */ }
      return {
        ok: true,
        sessionId: expectedReceipt.sessionId,
        limitEventId: expectedReceipt.limitEventId,
      };
    }
    if (!sameReceipt(activeReceipt(agentName, pane), expectedReceipt)) {
      return { ok: false, reason: "limit-receipt-superseded" };
    }

    await tmux.respawnPane(target, { kill: true, cwd: targetConfig.cwd });
    if (!await waitForShell(target)) return { ok: false, reason: "replacement-shell-not-ready" };
    const launch = buildClaudeLaunchCommand({ resumeSessionId: expectedReceipt.sessionId });
    await tmux.runShell(target, `cd '${targetConfig.cwd.replaceAll("'", "'\\''")}' && ${launch}`);
    if (!await waitForComposer(target)) return { ok: false, reason: "resumed-composer-not-ready" };

    try {
      record({
        ts: new Date().toISOString(),
        event: "quota_recovery",
        session: agentName,
        pane: Number(pane) || 0,
        state: "restarted",
        detail: expectedReceipt.sessionId,
      });
    } catch { /* diagnostics never invalidate a successful process boundary */ }
    return {
      ok: true,
      sessionId: expectedReceipt.sessionId,
      limitEventId: expectedReceipt.limitEventId,
    };
  }

  return { activeReceipt, restart };
}
