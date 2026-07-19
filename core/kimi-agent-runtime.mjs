// Kimi-specific TUI lifecycle and durable transport helpers.

import { existsSync } from "node:fs";
import { esc, stripAnsi } from "../lib.mjs";
import { buildKimiLaunchCommand } from "./agent-launch-command.mjs";
import {
  captureKimiPromptEchoCursor,
  extractFromKimiJsonl,
  getContextFromKimiJsonl,
  isBusyFromKimiJsonl,
  isPromptInKimiJsonl,
  latestKimiSessionIdentity,
} from "./kimi-jsonl-reader.mjs";
import { isKimiPaneCommand } from "./tui-stall-recovery.mjs";

const PROMPT_READY_TIMEOUT_MS = 15_000;

/** WHAT: Defines Kimi Wire operations. WHY: Keeps engine dispatch separate from journal internals. */
export const kimiJournal = Object.freeze({
  capturePromptCursor: captureKimiPromptEchoCursor,
  context: getContextFromKimiJsonl,
  extract: extractFromKimiJsonl,
  isBusy: isBusyFromKimiJsonl,
  promptAccepted: isPromptInKimiJsonl,
});

/** WHAT: Builds Kimi pane lifecycle operations. WHY: Keeps agent orchestration below its legacy size cap. */
export function createKimiAgentRuntime({
  t,
  wait,
  paneDir,
  agentConfig,
  isBusy,
  isPaneDead,
  respawnPane,
  isAlreadyRunning,
  isShellProcess,
  captureScreen,
  promptAlreadyInComposer,
}) {
  function blocked(message) {
    const error = new Error(message);
    error.code = "AMUX_DELIVERY_BLOCKED";
    return error;
  }

  async function startKimi(name, target, rootDir, pane = 0, launch = null) {
    if (await isPaneDead(target)) await respawnPane(target);
    if (await isAlreadyRunning(target)) return;
    const dir = paneDir(rootDir, pane);
    const paneConfig = agentConfig(name).panes?.[pane] || {};
    const discovered = latestKimiSessionIdentity(dir);
    const resumeSessionId = launch?.resumeSessionId
      || paneConfig.resumeSessionId
      || discovered?.sessionId
      || null;
    const model = launch?.model || paneConfig.model || "kimi-code/k3";
    const executable = process.env.KIMI_CODE_BIN
      || `${process.env.HOME}/.kimi-code/bin/kimi`;
    if (!existsSync(executable)) {
      throw new Error(`Kimi Code CLI is not installed at ${executable}`);
    }
    const cmd = buildKimiLaunchCommand({
      executable,
      model,
      resumeSessionId,
      allowFreshBootstrap: !resumeSessionId,
    });
    await t.runShell(target, `cd ${esc(dir)} && ${cmd}`);
    await wait(1500);
  }

  async function waitForKimiUiReady(
    target,
    agentName,
    pane,
    timeoutMs = PROMPT_READY_TIMEOUT_MS,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [command, screen] = await Promise.all([
        t.currentCommand(target).catch(() => ""),
        t.captureScreen(target).catch(() => ""),
      ]);
      if (/^(kimi|kimi-code)$/u.test(command) && /^\s*>\s*$/mu.test(stripAnsi(screen))) return true;
      await wait(250);
    }
    console.warn(`waitForKimiUiReady(${agentName}:${pane}) stalled before ${timeoutMs}ms`);
    return false;
  }

  async function restartKimi(agentName, pane) {
    const config = agentConfig(agentName);
    const paneCmd = config.panes?.[pane]?.cmd || "";
    if (!isKimiPaneCommand(paneCmd)) throw new Error(`${agentName}:${pane} is not a Kimi pane`);
    if (await isBusy(agentName, pane)) throw new Error(`${agentName}:${pane} is still working`);
    const target = `${agentName}:.${pane}`;
    const dir = paneDir(config.dir, pane);
    const identity = latestKimiSessionIdentity(dir);
    if (!identity?.sessionId) {
      throw new Error(`Kimi continuity blocked for ${agentName}:${pane}: exact persisted session not found`);
    }
    await t.respawnPane(target, { kill: true, cwd: dir });
    const shellDeadline = Date.now() + 5_000;
    while (Date.now() < shellDeadline) {
      if (isShellProcess(await t.currentCommand(target).catch(() => ""))) break;
      await wait(100);
    }
    const model = config.panes?.[pane]?.model || "kimi-code/k3";
    await startKimi(agentName, target, config.dir, pane, {
      resumeSessionId: identity.sessionId,
      model,
    });
    if (!await waitForKimiUiReady(target, agentName, pane)) {
      throw new Error(`Kimi process started but its composer never became ready in ${agentName}:${pane}`);
    }
    return { ok: true, model, sessionId: identity.sessionId };
  }

  async function waitForKimiPromptReady(agentName, pane) {
    const deadline = Date.now() + PROMPT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (await isBusy(agentName, pane).catch(() => true)) {
        throw blocked("Kimi prompt delivery blocked: pane is working; wait for its current turn to finish");
      }
      if (/^\s*>\s*$/mu.test(await captureScreen(agentName, pane).catch(() => ""))) return true;
      await wait(250);
    }
    throw blocked("Kimi prompt delivery timed out: composer is not ready");
  }

  async function maybeRescueKimiSubmit(agentName, pane, target, prompt, {
    notBeforeMs = 0,
  } = {}) {
    let dir;
    try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { return; }
    const submitted = () => {
      try { return isPromptInKimiJsonl(dir, prompt, { notBeforeMs }) === true; }
      catch { return false; }
    };
    await wait(600);
    if (submitted()) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await isBusy(agentName, pane).catch(() => true)) return;
      if (!await promptAlreadyInComposer(agentName, pane, prompt)) return;
      if (submitted()) return;
      await t.sendEnter(target);
      await wait(600);
      if (submitted()) return;
    }
  }

  return {
    maybeRescueKimiSubmit,
    restartKimi,
    startKimi,
    waitForKimiPromptReady,
    waitForKimiUiReady,
  };
}
