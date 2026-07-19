// Conservative recovery for coding-agent panes whose live TUI stops rendering.

import { buildClaudeLaunchCommand } from "./agent-launch-command.mjs";
import { getContextPercent } from "./context.mjs";
import { codexModelOverride, selectedCodexProfile } from "./codex-profiles.mjs";
import { findBlockingPrompt, hasEmptyClaudeComposer } from "./dismiss.mjs";
import {
  latestClaudeSessionIdentity,
  latestPaneSessionIdentity,
} from "./native-session-identity.mjs";
import { latestKimiSessionIdentity } from "./kimi-jsonl-reader.mjs";
import { paneModelSelection, setPaneModelSelection } from "./pane-model-state.mjs";
import { waitForProgressingUi } from "./progressing-ui.mjs";
import { esc } from "../lib.mjs";

const TUI_ESCAPE_AFTER_MS = 2 * 60_000;
const TUI_RESTART_AFTER_MS = 5 * 60_000;

/** WHAT: Checks whether a pane command starts Claude. WHY: Keeps lifecycle routing independent from display names. */
export const isClaudePaneCommand = (command) => /(?:^|\s)claude(?:\s|$)/u.test(String(command || ""));
/** WHAT: Checks whether a pane command starts Codex. WHY: Keeps lifecycle routing independent from display names. */
export const isCodexPaneCommand = (command) => /(?:^|\s)codex(?:\s|$)/u.test(String(command || ""));
/** WHAT: Checks whether a pane starts Kimi Code. WHY: Keeps absolute installer paths inside Kimi recovery. */
export const isKimiPaneCommand = (command) => /(?:^|[\/\s])kimi(?:-code)?(?:\s|$)/u.test(String(command || ""));
/** WHAT: Checks whether a pane runs a coding agent. WHY: Keeps service panes outside recovery boundaries. */
export const isCodingPaneCommand = (command) =>
  isClaudePaneCommand(command) || isCodexPaneCommand(command) || isKimiPaneCommand(command);
/** WHAT: Checks whether a process is an interactive shell. WHY: Keeps restart commands behind a ready PTY. */
export const isShellProcess = (command) => /^(bash|zsh|sh|fish|dash)$/u.test(String(command || ""));

/**
 * WHAT: Builds exact-session Claude and exact-pane recovery operations.
 * WHY: Keeps crash recovery policy outside the legacy agent transport file.
 */
export function createTuiStallRecovery({
  tmux, state, delay, configFor, paneDirectory, isPaneDead, respawnPane,
  isAlreadyRunning, resolveSessionFlag, isBusy, promptTransportState, restartCodex, restartKimi,
} = {}) {
  /** WHAT: Observes one pane process. WHY: Proves whether a fenced submission can still be ingested. */
  async function paneProcessState(agentName, pane) {
    const target = `${agentName}:.${pane}`;
    const dead = await isPaneDead(target);
    const command = await tmux.currentCommand(target).catch(() => null);
    return {
      command,
      dead,
      shell: isShellProcess(command),
      running: /^(claude|codex|kimi|kimi-code|node)$/u.test(command || ""),
    };
  }

  /** WHAT: Starts Claude with pane history and model. WHY: Keeps restarts from reverting Fable to fleet defaults. */
  async function startClaude(name, target, rootDir, pane = 0) {
    if (await isPaneDead(target)) await respawnPane(target);
    if (await isAlreadyRunning(target)) return;
    const dir = paneDirectory(rootDir, pane);
    const configuredSessionId = configFor(name).panes?.[pane]?.resumeSessionId || null;
    const discovered = configuredSessionId ? null : latestClaudeSessionIdentity(dir);
    const resumeSessionId = configuredSessionId || discovered?.sessionId || null;
    const sessionFlag = resumeSessionId ? "" : await resolveSessionFlag(dir, name, pane);
    let rememberedModel = paneModelSelection(state, name, pane)?.model || null;
    if (!rememberedModel) {
      rememberedModel = getContextPercent(dir, "claude")?.model || null;
      if (rememberedModel && state) setPaneModelSelection(state, name, pane, rememberedModel);
    }
    const command = buildClaudeLaunchCommand({
      resume: !resumeSessionId && sessionFlag === "--continue",
      resumeSessionId,
      model: rememberedModel || undefined,
    });
    await tmux.runShell(target, `cd ${esc(dir)} && ${command}`);
    await delay(2000);
  }

  /** WHAT: Waits for a live Claude composer. WHY: Keeps stale JSONL idle state from skipping summary confirmation. */
  async function waitForClaudeReady(target, agentName, pane, timeoutMs = 120_000) {
    for (let attempt = 0; attempt < 15; attempt++) {
      if (await isAlreadyRunning(target)) break;
      await delay(500);
    }
    const ready = await waitForProgressingUi({
      capture: () => tmux.captureScreen(target),
      inspect: async (screen) => {
        const blocker = findBlockingPrompt(screen);
        if (blocker) {
          await tmux.sendKeys(target, blocker.keys);
          return { waitMs: blocker.waitMs };
        }
        return hasEmptyClaudeComposer(screen);
      },
      delay,
      hardTimeoutMs: timeoutMs,
    });
    if (!ready) console.warn(`waitForClaudeReady(${agentName}:${pane}) stalled before ${timeoutMs}ms`);
    return ready;
  }

  /** WHAT: Restarts one proven-idle pane exactly. WHY: Keeps watchdog recovery from guessing sessions or models. */
  async function restartPaneExact(agentName, pane, { expectedDraft = null } = {}) {
    const config = configFor(agentName);
    const paneCmd = config.panes?.[pane]?.cmd || "";
    if (await isBusy(agentName, pane)) return { ok: false, reason: "pane-is-busy" };
    const transport = await promptTransportState(agentName, pane, expectedDraft || "").catch(() => null);
    if (transport?.state === "foreign" || (transport?.state === "drafted" && !expectedDraft)) {
      return { ok: false, reason: `composer-${transport.state}` };
    }
    if (isCodexPaneCommand(paneCmd)) {
      const override = codexModelOverride(state, agentName, pane);
      await restartCodex(agentName, pane, {
        profile: selectedCodexProfile(state, agentName, pane),
        model: override?.model || null,
        effort: override?.effort || null,
      });
      return { ok: true, dialect: "codex" };
    }
    if (isKimiPaneCommand(paneCmd)) {
      await restartKimi(agentName, pane);
      return { ok: true, dialect: "kimi" };
    }
    if (!isClaudePaneCommand(paneCmd)) return { ok: false, reason: "not-a-coding-pane" };
    const target = `${agentName}:.${pane}`;
    const dir = paneDirectory(config.dir, pane);
    await tmux.respawnPane(target, { kill: true, cwd: dir });
    const shellDeadline = Date.now() + 5_000;
    while (Date.now() < shellDeadline) {
      if (isShellProcess(await tmux.currentCommand(target).catch(() => ""))) break;
      await delay(100);
    }
    await startClaude(agentName, target, config.dir, pane);
    if (!await waitForClaudeReady(target, agentName, pane)) {
      return { ok: false, reason: "claude-composer-not-ready" };
    }
    const command = await tmux.currentCommand(target).catch(() => "");
    return /^(claude|node)$/u.test(command)
      ? { ok: true, dialect: "claude" }
      : { ok: false, reason: "claude-process-not-ready" };
  }

  /** WHAT: Captures active pane session identities. WHY: Keeps fleet restarts from waking idle panes. */
  async function interruptedFleetTargets(fleet, log) {
    const targets = [];
    for (const { name, cfg } of fleet) {
      for (let pane = 0; pane < cfg.panes.length; pane++) {
        const command = cfg.panes[pane]?.cmd || "";
        if (!isCodingPaneCommand(command)) continue;
        try {
          if (!await isBusy(name, pane)) continue;
          const dialect = isClaudePaneCommand(command)
            ? "claude"
            : isCodexPaneCommand(command) ? "codex" : "kimi";
          const cwd = paneDirectory(cfg.dir, pane);
          const identity = dialect === "kimi"
            ? latestKimiSessionIdentity(cwd)
            : latestPaneSessionIdentity(dialect, cwd);
          if (identity?.sessionId) targets.push({
            agentName: name,
            pane,
            dialect,
            sessionId: identity.sessionId,
          });
        } catch (error) {
          log(`fleet restart: could not snapshot ${name}:${pane}: ${error.message}`);
        }
      }
    }
    return targets;
  }

  return { startClaude, waitForClaudeReady, restartPaneExact, interruptedFleetTargets, paneProcessState };
}

export { recoverSubmittedTui } from "./submitted-tui-recovery.mjs";

/**
 * WHAT: Routes one old hidden idle delivery TUI.
 * WHY: Keeps durable FIFO heads from waiting forever behind dead compositors.
 */
export async function recoverHiddenDeliveryTui({ job, reason, agent, queue, now, queueEvent, log }) {
  const ageMs = now() - Number(job.firstAttemptAt || job.createdAt || now());
  if (job.draftOwned || ageMs < TUI_ESCAPE_AFTER_MS
      || typeof agent.promptTransportState !== "function") return job;
  const transport = await agent.promptTransportState(job.agentName, job.pane, job.text)
    .catch(() => null);
  if (transport?.state !== "hidden" || transport.busy !== false) return job;
  const metadata = { ...(job.metadata || {}) };
  if (!metadata.tuiRecoveryEscapeAt) {
    metadata.tuiRecoveryEscapeAt = now();
    const escaped = queue.update(job, {
      metadata,
      nextAttemptAt: now() + 1_000,
      lastReason: `${reason}; idle hidden TUI received one recovery Escape`,
    });
    await agent.sendEscape(job.agentName, job.pane).catch((error) =>
      log(`delivery TUI Escape failed for ${job.agentName}:${job.pane}: ${error.message}`));
    queueEvent(escaped, "tui_recovery_escape");
    return escaped;
  }
  if (ageMs < TUI_RESTART_AFTER_MS || metadata.tuiRecoveryRestartAt
      || typeof agent.restartPaneExact !== "function") return job;
  metadata.tuiRecoveryRestartAt = now();
  let recovering = queue.update(job, {
    metadata,
    nextAttemptAt: now() + 1_000,
    lastReason: `${reason}; restarting the exact idle pane session after Escape did not recover its TUI`,
  });
  const result = await agent.restartPaneExact(job.agentName, job.pane)
    .catch((error) => ({ ok: false, reason: error.message }));
  recovering = queue.update(recovering, {
    metadata: {
      ...(recovering.metadata || {}),
      tuiRecoveryRestartResult: result?.ok ? "resumed" : `failed:${result?.reason || "unknown"}`,
    },
    nextAttemptAt: now() + 1_000,
    lastReason: result?.ok
      ? "exact pane session/model resumed after an idle hidden TUI stall; retrying durable delivery"
      : `${reason}; exact TUI recovery failed: ${result?.reason || "unknown"}`,
  });
  queueEvent(recovering, result?.ok ? "tui_recovery_resumed" : "tui_recovery_failed");
  return recovering;
}
