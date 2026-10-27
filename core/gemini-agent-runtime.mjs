// Gemini owns its persistent TUI. AMUX owns exact-session lifecycle and ordinary durable TUI delivery.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { esc } from "../lib.mjs";
import { assertGeminiStartPolicy, buildGeminiLaunchCommand, geminiChildEnvironment, geminiProfileHome } from "./gemini-launch.mjs";
import { latestGeminiSessionIdentity, prepareGeminiRuntimeFiles, publishGeminiRuntime } from "./gemini-pane-files.mjs";
import { readQwenJournalWindow as readJournalWindow } from "./qwen-journal-window.mjs";
import { captureGeminiPromptEchoCursor, extractFromGeminiJsonl, getContextFromGeminiJsonl,
  isBusyFromGeminiJsonl, isPromptInGeminiJsonl } from "./gemini-jsonl-reader.mjs";

/** WHAT: Defines Gemini's pane journal operations. WHY: Keeps generic delivery and observation off provider-specific file paths. */
export const geminiJournal = Object.freeze({ capturePromptCursor: captureGeminiPromptEchoCursor,
  context: getContextFromGeminiJsonl, extract: extractFromGeminiJsonl,
  isBusy: isBusyFromGeminiJsonl, promptAccepted: isPromptInGeminiJsonl });

function profileSettings(profileHome, cwd) {
  let path = resolve(cwd);
  while (true) {
    if (existsSync(join(path, ".gemini", ".env"))) throw new Error("Gemini profile refuses a workspace .gemini/.env");
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  if (existsSync(join(profileHome, ".env")) || existsSync(join(profileHome, ".gemini", ".env"))) {
    throw new Error("Gemini profile refuses a profile dotenv file");
  }
  let settings;
  try { settings = JSON.parse(readFileSync(join(profileHome, ".gemini", "settings.json"), "utf8")); }
  catch { throw new Error("Gemini profile settings are missing or invalid; explicit Google login setup is required"); }
  assertGeminiStartPolicy({ profileHome, settings, env: geminiChildEnvironment(process.env) });
  return settings;
}

function managedSettings(files) {
  const hook = fileURLToPath(new URL("../bin/gemini-hook.mjs", import.meta.url));
  const command = `'${esc(process.execPath)}' '${esc(hook)}'`;
  const settings = { security: { auth: { selectedType: "oauth-personal", enforcedType: "oauth-personal" } },
    general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
    advanced: { ignoreLocalEnv: true, autoConfigureMemory: false },
    context: { fileName: ["AGENTS.md", "GEMINI.md"] }, hooksConfig: { enabled: true },
    hooks: Object.fromEntries(["SessionStart", "BeforeAgent", "AfterAgent", "SessionEnd"].map(name =>
      [name, [{ hooks: [{ name: `amux-${name}`, type: "command", command }] }]])) };
  const path = join(files.root, `settings-${files.generation}.json`);
  writeFileSync(path, `${JSON.stringify(settings)}\n`, { mode: 0o600, flag: "wx" });
  return path;
}

/** WHAT: Builds one subscription-only Gemini lifecycle. WHY: Keeps provider startup and continuity outside the generic delivery broker. */
export function createGeminiAgentRuntime({
  t, wait, paneDir, agentConfig, isBusy, isPaneDead, respawnPane, isAlreadyRunning,
  isShellProcess, captureScreen, assertEngineStartAllowed, stateRoot = null, profileRoot,
  executable = process.env.GEMINI_CLI_BIN || `${process.env.HOME}/.nvm/versions/node/${process.version}/bin/gemini`,
  readyTimeoutMs = 45_000, now = () => performance.now(),
} = {}) {
  async function waitForGeminiUiReady(target, agentName, pane, files, timeoutMs = readyTimeoutMs) {
    const deadline = now() + timeoutMs;
    while (now() < deadline) {
      const [command, screen] = await Promise.all([t.currentCommand(target).catch(() => ""), captureScreen(agentName, pane).catch(() => "")]);
      const hooks = readJournalWindow(files.eventsPath, { head: true, maxBytes: 64 * 1024 }).events;
      const start = hooks.find(event => event.hook_event_name === "SessionStart");
      if (start) {
        try {
          // Publication itself is the exact identity/environment admission, never merely a painted prompt.
          if (/^(?:gemini|node)$/u.test(command) && /^\s*\*\s+Type your message(?: or @path\/to\/file)?\s*$/mu.test(screen)) {
            return publishGeminiRuntime(files);
          }
          if (Object.values(start.environment || {}).some(value => value === true)) publishGeminiRuntime(files);
        } catch (error) {
          await t.respawnPane(target, { kill: true, cwd: files.paneDir });
          throw error;
        }
      }
      if (/Enter the authorization code:|Please visit the following URL to authorize/u.test(screen)) {
        await t.respawnPane(target, { kill: true, cwd: files.paneDir });
        throw new Error("Gemini startup refused: Google login is required; no prompt was delivered");
      }
      await wait(250);
    }
    await t.respawnPane(target, { kill: true, cwd: files.paneDir });
    throw new Error("Gemini startup refused: exact clean SessionStart and composer did not become ready");
  }

  async function startGemini(name, target, rootDir, pane = 0, launch = null) {
    const dir = paneDir(rootDir, pane);
    const config = agentConfig(name).panes?.[pane] || {};
    const profileHome = geminiProfileHome(config.geminiProfile, profileRoot);
    profileSettings(profileHome, dir);
    const previous = latestGeminiSessionIdentity(dir, { stateRoot, strict: true });
    if (previous && previous.profileHome !== profileHome) throw new Error("Gemini continuity blocked: profile change is unsupported");
    if (await isAlreadyRunning(target)) {
      if (!previous?.publishedAt) throw new Error("Gemini continuity blocked: running process has no published identity");
      return { started: false, identity: previous };
    }
    const resumeSessionId = launch?.resumeSessionId || config.resumeSessionId || previous?.sessionId;
    if (previous && resumeSessionId !== previous.sessionId) throw new Error("Gemini continuity blocked: configured session differs from persisted identity");
    await assertEngineStartAllowed({ session: name, pane, dir, sessionId: resumeSessionId, engine: "gemini" });
    if (!existsSync(executable)) throw new Error("Gemini CLI executable is unavailable");
    const files = prepareGeminiRuntimeFiles(dir, { stateRoot, profileHome,
      sessionId: resumeSessionId || randomUUID(), model: launch?.model ?? config.model ?? null });
    const settingsPath = managedSettings(files);
    const command = buildGeminiLaunchCommand({ executable, profileHome, sessionId: files.sessionId,
      resume: Boolean(resumeSessionId), allowFreshBootstrap: !resumeSessionId, model: files.model,
      eventPath: files.eventsPath, generation: files.generation, cwd: dir, settingsPath });
    if (await isPaneDead(target)) await respawnPane(target);
    // sendLiteral owns quoting of the complete shell line; its cwd/executable argv retain their own quotes.
    await t.sendLiteral(target, `cd '${esc(dir)}' && ${command}`);
    await t.sendEnter(target);
    const identity = await waitForGeminiUiReady(target, name, pane, files);
    return { started: true, identity };
  }

  async function restartGemini(agentName, pane) {
    const config = agentConfig(agentName);
    const dir = paneDir(config.dir, pane);
    const identity = latestGeminiSessionIdentity(dir, { stateRoot, strict: true });
    if (!identity?.sessionId) throw new Error("Gemini continuity blocked: exact session not found");
    if (await isBusy(agentName, pane)) throw new Error(`${agentName}:${pane} is still working`);
    const target = `${agentName}:.${pane}`;
    await t.respawnPane(target, { kill: true, cwd: dir });
    const deadline = now() + 5000;
    while (now() < deadline) {
      if (isShellProcess(await t.currentCommand(target).catch(() => ""))) break;
      await wait(100);
    }
    await startGemini(agentName, target, config.dir, pane, { resumeSessionId: identity.sessionId, model: identity.model });
    return { ok: true, sessionId: identity.sessionId, model: identity.model };
  }

  return { startGemini, restartGemini, waitForGeminiUiReady };
}
