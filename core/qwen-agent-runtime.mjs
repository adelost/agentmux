// Qwen Code lifecycle. The persistent TUI is the agent; Dual Output only supplies exact AMUX receipts.

import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { buildQwenLaunchCommand } from "./agent-launch-command.mjs";
import {
  captureQwenPromptEchoCursor,
  extractFromQwenJsonl,
  getContextFromQwenJsonl,
  isBusyFromQwenJsonl,
  isPromptInQwenJsonl,
  latestQwenSessionIdentity,
  prepareQwenRuntimeFiles,
  publishQwenRuntime,
  submitQwenPrompt,
} from "./qwen-jsonl-reader.mjs";
import { esc } from "../lib.mjs";

const READY_TIMEOUT_MS = 45_000;

/** WHAT: Defines Qwen's structured AMUX journal operations. WHY: Keeps delivery and mirroring independent of terminal width. */
export const qwenJournal = Object.freeze({
  capturePromptCursor: captureQwenPromptEchoCursor,
  context: getContextFromQwenJsonl,
  extract: extractFromQwenJsonl,
  isBusy: isBusyFromQwenJsonl,
  promptAccepted: isPromptInQwenJsonl,
});

function handshakeMatches(path, { sessionId, paneDir }) {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).some((line) => {
      const event = JSON.parse(line);
      return event?.type === "system"
        && event.subtype === "session_start"
        && event.session_id === sessionId
        && event.data?.protocol_version >= 2
        && event.data?.cwd === paneDir;
    });
  } catch { return false; }
}

/** WHAT: Builds one Qwen pane runtime. WHY: Keeps provider-specific lifecycle outside the generic broker. */
export function createQwenAgentRuntime({
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
  stateRoot = null,
} = {}) {
  async function waitForQwenUiReady(target, agentName, pane, files, timeoutMs = READY_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    let modalDismissed = false;
    while (Date.now() < deadline) {
      const [command, screen] = await Promise.all([
        t.currentCommand(target).catch(() => ""),
        captureScreen(agentName, pane).catch(() => ""),
      ]);
      if (/Built-in Provider Update[\s\S]*Update all/u.test(screen)) {
        if (!modalDismissed) {
          modalDismissed = true;
          await t.sendKeys(target, "Escape").catch(() => {});
        }
        await wait(250);
        continue;
      }
      const processReady = /^(?:qwen|node)$/u.test(command);
      // Qwen 0.23.x renders the composer as "*   Type your message"; earlier
      // builds used ">". A ">"-only pattern made every restart fail its ready
      // check, so restartQwen killed and respawned the pane forever.
      const composerReady = /[*>]\s+Type your message/u.test(screen);
      if (processReady && composerReady && handshakeMatches(files.eventsPath, files)) return true;
      await wait(250);
    }
    console.warn(`waitForQwenUiReady(${agentName}:${pane}) stalled before ${timeoutMs}ms`);
    return false;
  }

  async function startQwen(name, target, rootDir, pane = 0, launch = null) {
    if (await isPaneDead(target)) await respawnPane(target);
    if (await isAlreadyRunning(target)) return { started: false, identity: latestQwenSessionIdentity(paneDir(rootDir, pane), { stateRoot }) };
    const dir = paneDir(rootDir, pane);
    const paneConfig = agentConfig(name).panes?.[pane] || {};
    const previous = latestQwenSessionIdentity(dir, { stateRoot });
    const sessionId = launch?.resumeSessionId || paneConfig.resumeSessionId || previous?.sessionId || randomUUID();
    const model = launch?.model || paneConfig.model || previous?.model || "qwen3.8-max";
    const executable = process.env.QWEN_CODE_BIN || `${process.env.HOME}/.local/bin/qwen`;
    if (!existsSync(executable)) throw new Error(`Qwen Code CLI is not installed at ${executable}`);
    const files = prepareQwenRuntimeFiles(dir, { stateRoot, sessionId, model });
    const command = buildQwenLaunchCommand({
      executable,
      model,
      sessionId,
      resume: Boolean(previous || launch?.resumeSessionId),
      allowFreshBootstrap: !previous && !launch?.resumeSessionId,
      eventPath: files.eventsPath,
      inputPath: files.inputPath,
    });
    await t.runShell(target, `cd ${esc(dir)} && ${command}`);
    if (!await waitForQwenUiReady(target, name, pane, files)) {
      throw new Error(`Qwen process started but its composer/sidecar never became ready in ${name}:${pane}`);
    }
    const identity = publishQwenRuntime(files);
    return { started: true, identity };
  }

  async function submitPrompt(agentName, pane, prompt) {
    const dir = paneDir(agentConfig(agentName).dir, pane);
    return submitQwenPrompt(dir, prompt, { stateRoot });
  }

  async function restartQwen(agentName, pane) {
    const config = agentConfig(agentName);
    const identity = latestQwenSessionIdentity(paneDir(config.dir, pane), { stateRoot });
    if (!identity?.sessionId) {
      throw new Error(`Qwen continuity blocked for ${agentName}:${pane}: exact persisted session not found`);
    }
    if (await isBusy(agentName, pane)) throw new Error(`${agentName}:${pane} is still working`);
    const target = `${agentName}:.${pane}`;
    await t.respawnPane(target, { kill: true, cwd: paneDir(config.dir, pane) });
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (isShellProcess(await t.currentCommand(target).catch(() => ""))) break;
      await wait(100);
    }
    await startQwen(agentName, target, config.dir, pane, {
      resumeSessionId: identity.sessionId,
      model: identity.model,
    });
    return { ok: true, model: identity.model, sessionId: identity.sessionId };
  }

  return { restartQwen, startQwen, submitPrompt, waitForQwenUiReady };
}
