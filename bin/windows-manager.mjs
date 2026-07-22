#!/usr/bin/env node
// Thin Windows-native manager loop for the _windows_ channel. Prompt text and
// decisions live in core/; this file only does Discord I/O, bounded process
// runs, journaling, and the poll loop. //commands stay owned by the restarter.

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatWindowsStatus, planAcceptedAction } from "../core/windows-bridge.mjs";
import {
  MANAGER_CONTRACT_VERSION,
  MANAGER_TOOLS,
  classifyManagerOutcome,
  createManagerProvider,
  formatLocalRescueAnswer,
  formatProviderFallback,
  parseToolCalls,
  planLocalRescueTurn,
  planManagerTurn,
  planRescueCommand,
  planToolCall,
  redactSecrets,
  trackManagerBootId,
} from "../core/windows-manager.mjs";
import { mapRecoveryChainResults } from "../core/windows-recovery.mjs";
import { pollManagerDiscord } from "../core/windows-manager-discord.mjs";
import { claimManagerSingleton, createVoiceTranscriber } from "../core/windows-manager-input.mjs";
import { createSerialTurnLane, startWindowsManagerPhone } from "../core/windows-manager-phone-runtime.mjs";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));
const RESCUE_PATH = join(BIN_DIR, "windows-rescue-tool.ps1");
const TRANSCRIBE_PATH = join(BIN_DIR, "windows-transcribe.py");
const SNOWFLAKE = /^\d{17,20}$/u;
const MAX_DISCORD_CHUNK = 1900;
const PROBE_TIMEOUT_MS = 20_000;

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** WHAT: Reads the required Windows manager config with an exact failure class. WHY: Prevents invalid or unreadable JSON from masquerading as a missing installation. */
export function readManagerConfig(path) {
  if (!existsSync(path)) throw new Error(`manager config missing at ${path}`);
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`manager config unreadable at ${path}: ${error.code || error.message}`);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`manager config invalid JSON at ${path}: ${error.message}`);
  }
}

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

function logLine(logPath, message) {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} ${String(message).replace(/[\r\n]+/gu, " ")}\n`, "utf8");
  } catch { /* logging must never kill the rescue channel */ }
}

function runBounded(file, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      resolvePromise({
        ok: !error,
        timedOut: Boolean(error) && (error.killed === true || error.code === "ETIMEDOUT"),
        stdout: String(stdout || "").trim(),
        stderr: String(stderr || "").trim(),
      });
    });
  });
}

async function observeDefault() {
  const result = await runBounded("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RESCUE_PATH,
    "-Command", "get-status", "-TimeoutSeconds", "30"], PROBE_TIMEOUT_MS + 10_000);
  if (!result.ok) return { wsl: "unknown", wslReachable: false, timedOut: result.timedOut, error: "probe-unavailable" };
  try {
    const parsed = JSON.parse(result.stdout);
    return { ...parsed, wsl: parsed.wslReachable ? "online" : "offline" };
  } catch {
    return { wsl: "unknown", wslReachable: false, error: "probe-json-invalid" };
  }
}

function tailFile(path, maxLines) {
  try {
    return existsSync(path) ? readFileSync(path, "utf8").trimEnd().split(/\r?\n/u).slice(-maxLines).join("\n") : "";
  } catch { return ""; }
}

async function executeToolDefault(name, { rootDir, logPath, beforeBootId = null }) {
  const tool = MANAGER_TOOLS.find((entry) => entry.name === name);
  if (name === "get_status") {
    const observation = await observeDefault();
    return { ok: true, stage: "get_status", detail: formatWindowsStatus(observation), observation };
  }
  if (name === "get_logs") {
    const redacted = redactSecrets(`== restarter ==\n${tailFile(join(rootDir, "restarter.log"), 24)}\n== manager ==\n${tailFile(logPath, 24)}`);
    return { ok: true, stage: "get_logs", detail: redacted.length > 1750 ? redacted.slice(-1749) : redacted };
  }
  const plan = planRescueCommand({ name, beforeBootId });
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", RESCUE_PATH,
    "-Command", plan.command, "-TimeoutSeconds", String(Math.ceil(tool.timeoutMs / 1000))];
  if (plan.beforeBootId) args.push("-BeforeBootId", plan.beforeBootId);
  const bounded = await runBounded("powershell.exe", args, tool.timeoutMs + 10_000);
  if (bounded.timedOut) return { ok: false, stage: plan.command, detail: `timeout-${tool.timeoutMs}ms` };
  try {
    const parsed = JSON.parse(bounded.stdout);
    if (plan.command === "recover-verify") return mapRecoveryChainResults(parsed);
    const result = { ok: parsed.ok === true, stage: String(parsed.stage || plan.command), detail: redactSecrets(String(parsed.detail || "")) };
    return plan.degraded ? [result, { ok: false, stage: "recover-verify", detail: "skipped:before-boot-unknown" }] : result;
  } catch {
    return { ok: false, stage: plan.command, detail: "rescue-output-invalid" };
  }
}

/** WHAT: Dispatches one user turn through provider, tools, and final answer. WHY: Separates turn flow from Discord and process I/O. */
export async function runManagerTurn({ userText, messageId, state, history = [], deps }) {
  let observation = await deps.observe();
  trackManagerBootId(state, observation);
  const messages = planManagerTurn({ userText, observation, history, contractVersion: MANAGER_CONTRACT_VERSION });
  const local = planLocalRescueTurn(userText);
  const reply = local ? { ok: true, text: "local-rescue" } : await deps.provider.chat(messages);
  if (reply?.sessionId) { state.codexSessionId = reply.sessionId; deps.saveState(state); }
  if (!reply?.ok) {
    return { answer: formatProviderFallback(reply?.reason), toolResults: [], outcome: "PARTIAL", observation };
  }
  const toolResults = [];
  for (const name of (local?.tools || parseToolCalls(reply.text))) {
    const verdict = planToolCall({
      name,
      observation,
      lastStatusMs: state.lastStatusMs,
      nowMs: deps.nowMs(),
      explicitHumanRestart: local?.kind === "restart-wsl",
    });
    if (!verdict.allow) {
      toolResults.push({ ok: false, stage: name, detail: `refused:${verdict.reason}` });
      continue;
    }
    state.lastAction = planAcceptedAction({ messageId, command: name, generation: deps.generation, nowMs: deps.nowMs() });
    deps.saveState(state);
    const executed = await deps.executeTool(name, { observation, beforeBootId: state.prevBootId || null });
    toolResults.push(...(Array.isArray(executed) ? executed : [executed]));
    const result = toolResults[toolResults.length - 1];
    if (result.observation) {
      observation = result.observation;
      trackManagerBootId(state, observation);
      state.lastStatusMs = deps.nowMs();
    }
    state.lastAction.status = result.ok ? "completed" : "failed";
    state.lastAction.completedAt = new Date(deps.nowMs()).toISOString();
    state.lastAction.stage = result.stage;
    deps.saveState(state);
  }
  let answer = reply.text;
  let outcome = "ANSWERED";
  if (toolResults.length) {
    outcome = classifyManagerOutcome(toolResults).outcome;
    if (local) return { answer: formatLocalRescueAnswer(local, toolResults, outcome), toolResults, outcome, observation };
    const resultsText = redactSecrets(JSON.stringify(toolResults.map(({ observation: drop, ...rest }) => rest)));
    const followup = await deps.provider.chat([
      ...messages,
      { role: "assistant", content: reply.text },
      { role: "user", content: `Verktygsresultat (JSON):\n${resultsText}\nSvara kort på svenska med exakt utfall.` },
    ]);
    answer = followup?.ok
      ? followup.text
      : `AMUX ${outcome}: ${toolResults.map((result) => `${result.stage}=${result.ok ? "ok" : "fail"}`).join(" ")}`;
  }
  return { answer, toolResults, outcome, observation };
}

/** WHAT: Routes one Discord poll through filters, journal, turn, and cursor. WHY: Keeps crash fencing and message ownership in one place. */
export async function pollManagerChannel({ config, state, history = [], deps }) {
  return pollManagerDiscord({ config, state, history, deps, runTurn: runManagerTurn });
}

/** WHAT: Turns a leftover started action into a blocked fence. WHY: Prevents any ambiguous manager action from running twice. */
export function reconcileManagerStartup(state, { nowMs = Date.now() } = {}) {
  const action = state?.lastAction;
  if (!action || action.status !== "started") return { state, fenced: false };
  action.status = "blocked";
  action.completedAt = new Date(nowMs).toISOString();
  action.stage = "crashed-mid-action";
  state.lastAction = action;
  state.lastSeenId = String(action.messageId);
  return { state, fenced: true, fencedMessageId: String(action.messageId) };
}

function loadConfig() {
  const configPath = process.env.MANAGER_CONFIG
    || join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "AgentmuxRestarter", "manager.json");
  const config = readManagerConfig(configPath);
  if (!SNOWFLAKE.test(String(config.channelId)) || !SNOWFLAKE.test(String(config.authorizedUserId))) {
    throw new Error("manager config needs Discord snowflake channelId and authorizedUserId");
  }
  const kind = config.provider?.kind;
  if (kind !== "http" && kind !== "mock" && kind !== "cli") {
    throw new Error("manager provider.kind must be http, mock, or cli");
  }
  if (kind === "http" && (!config.provider.endpoint || !config.provider.model)) {
    throw new Error("manager http provider needs endpoint and model");
  }
  if (kind === "cli" && !config.provider.command) {
    throw new Error("manager cli provider needs a command");
  }
  return { config, rootDir: dirname(configPath) };
}

async function discordRequest(token, method, route, body) {
  const headers = { authorization: `Bot ${token}`, "user-agent": "agentmux-windows-manager/1" };
  if (body) headers["content-type"] = "application/json";
  const response = await fetch(`https://discord.com/api/v10${route}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`discord-${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function main() {
  const singleton = await claimManagerSingleton();
  const { config, rootDir } = loadConfig();
  process.chdir(rootDir);
  const token = process.env[config.discordTokenEnv || "DISCORD_TOKEN"];
  if (!token) throw new Error(`Discord token env var ${config.discordTokenEnv || "DISCORD_TOKEN"} is not set`);
  const statePath = join(rootDir, "manager-state.json");
  const pidPath = join(rootDir, "manager-process.json");
  const logPath = join(rootDir, "manager.log");
  mkdirSync(rootDir, { recursive: true });
  writeJsonAtomic(pidPath, { pid: process.pid, startedAt: new Date().toISOString() });
  process.on("exit", () => {
    singleton.close();
    if (readJson(pidPath)?.pid === process.pid) rmSync(pidPath, { force: true });
  });
  const generation = randomUUID().replaceAll("-", "");
  const state = readJson(statePath) || { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
  const startup = reconcileManagerStartup(state);
  if (startup.fenced) logLine(logPath, `leftover action ${startup.fencedMessageId} fenced BLOCKED crashed-mid-action`);
  state.generation = generation;
  writeJsonAtomic(statePath, state);
  logLine(logPath, `manager started pid=${process.pid} channel=${config.channelId} generation=${generation}`);
  const history = [];
  const serializeTurn = createSerialTurnLane();
  const deps = {
    generation,
    provider: createManagerProvider({ ...config, provider: { ...config.provider, initialSessionId: state.codexSessionId || null } }),
    nowMs: () => Date.now(),
    saveState: (next) => writeJsonAtomic(statePath, next),
    observe: observeDefault,
    executeTool: (name, context = {}) => executeToolDefault(name, { rootDir, logPath, beforeBootId: context.beforeBootId }),
    log: (line) => logLine(logPath, line),
    listMessages: async (after) => {
      const route = `/channels/${config.channelId}/messages?limit=50${after ? `&after=${after}` : ""}`;
      return (await discordRequest(token, "GET", route)) ?? [];
    },
    sendMessage: async (text) => {
      const clean = redactSecrets(String(text)).slice(0, 4 * MAX_DISCORD_CHUNK) || "AMUX BLOCKED empty-answer";
      for (let index = 0; index < clean.length; index += MAX_DISCORD_CHUNK) {
        await discordRequest(token, "POST", `/channels/${config.channelId}/messages`, {
          content: clean.slice(index, index + MAX_DISCORD_CHUNK),
          allowed_mentions: { parse: [] },
        });
      }
    },
    transcribeMessage: createVoiceTranscriber({ config, rootDir, scriptPath: TRANSCRIBE_PATH }),
  };
  await startWindowsManagerPhone({ config, rootDir, transcribePath: TRANSCRIBE_PATH,
    state, deps, history, serializeTurn, runManagerTurn, log: (line) => logLine(logPath, line) });
  const pollSeconds = Math.min(Math.max(Number(config.pollSeconds) || 5, 2), 60);
  for (;;) {
    try {
      await serializeTurn(() => pollManagerChannel({ config, state, history, deps }));
    } catch (error) {
      logLine(logPath, `poll failed: ${error?.message || error}`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollSeconds * 1000));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`manager fatal: ${error?.message || error}`);
    process.exitCode = 1;
  });
}
