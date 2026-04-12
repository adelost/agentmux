#!/usr/bin/env node
// Agentus — Discord bridge for tmux-based coding agents (Claude Code).
// Entry point: loads config, creates services, wires everything together.

// Crash guard: log and exit (start.sh restarts us)
process.on("unhandledRejection", (err) => {
  console.error(`[${new Date().toISOString()}] unhandled rejection:`, err);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error(`[${new Date().toISOString()}] uncaught exception:`, err);
  process.exit(1);
});

import { exec as execCb } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseEnv, downloadBuffer } from "./lib.mjs";
import { createAgent } from "./agent.mjs";
import { createAttachmentHandler } from "./attachments.mjs";
import { createState } from "./core/state.mjs";
import { createRecorder } from "./core/recorder.mjs";
import { createTTS } from "./tts.mjs";
import { createHandlers } from "./handlers.mjs";
import { startBot } from "./bot.mjs";
import { createDiscordChannel } from "./channels/discord.mjs";

// --- Config ---

const __dir = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const vars = parseEnv(readFileSync(resolve(__dir, ".env"), "utf-8"));
    for (const [k, v] of Object.entries(vars)) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
}

loadEnv();

const TOKEN = process.env.DISCORD_TOKEN;
const AGENTS_YAML = process.env.AGENTS_YAML || resolve(__dir, "agents.yaml");
const AGENTMUX_YAML = process.env.AGENTMUX_YAML || process.env.AGENTUS_YAML || resolve(__dir, "agentmux.yaml");
const TIMEOUT = parseInt(process.env.TIMEOUT_S || "600") * 1000;
const WHISPER_URL = process.env.WHISPER_URL || "http://localhost:2022/v1/audio/transcriptions";
const SHELL_PATH = process.env.SHELL_PATH || `${process.env.HOME}/bin:${process.env.PATH}`;
const TMUX_SOCKET = process.env.TMUX_SOCKET || "/tmp/agentmux.sock";
const TTS_VOICE = process.env.TTS_VOICE || "sv-SE-MattiasNeural";
const STATE_FILE = process.env.STATE_FILE || "/tmp/agentmux-state.json";

if (!TOKEN) {
  console.error("Set DISCORD_TOKEN in .env");
  process.exit(1);
}

// --- Services ---

const exec = promisify(execCb);
const run = (cmd, timeoutMs = TIMEOUT) =>
  exec(cmd, { timeout: timeoutMs, env: { ...process.env, PATH: SHELL_PATH }, maxBuffer: 1024 * 1024 });
const tmuxExec = (cmd) =>
  exec(cmd, { timeout: 3000, env: { ...process.env, PATH: SHELL_PATH } });

const appState = createState(STATE_FILE);
if (appState.get("tts") === undefined) appState.set("tts", process.env.TTS === "1");
if (appState.get("thinking") === undefined) appState.set("thinking", true);

const agent = createAgent({ tmuxSocket: TMUX_SOCKET, configPath: AGENTS_YAML, timeout: TIMEOUT, run, tmuxExec });
const attachments = createAttachmentHandler({
  run,
  transcribeScript: process.env.TRANSCRIBE_SCRIPT || resolve(__dir, "bin/transcribe-whisper.sh"),
  downloadBuffer,
});
const tts = createTTS({ run, state: appState, voice: TTS_VOICE });
const recorder = createRecorder({
  dir: process.env.AGENTUS_RECORD === "1" ? resolve(__dir, "test/recordings") : null,
});
if (recorder.enabled) console.log(`recorder | enabled → ${resolve(__dir, "test/recordings")}`);

// --- Channels ---

const discord = createDiscordChannel({ token: TOKEN });

// --- Wire up ---

const { getMapping, overrides, channelMap, reloadConfig } = startBot({
  channels: [discord],
  agentsYaml: AGENTS_YAML,
  whisperUrl: WHISPER_URL,
  agent,
  tts,
  state: appState,
  // onMessage is set below after handlers are created (circular dep)
  onMessage: (...args) => handlers.onMessage(...args),
});

const handlers = createHandlers({
  agent,
  attachments,
  tts,
  state: appState,
  getMapping,
  overrides,
  channelMap,
  reloadConfig,
  discordChannel: discord,
  agentusYamlPath: AGENTMUX_YAML,
  agentsYamlPath: AGENTS_YAML,
  recorder,
});
