#!/usr/bin/env node
// agentmux. Discord bridge for tmux-based coding agents (Claude Code).
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
import { readFileSync, existsSync } from "fs";
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
import { createVoicePWA } from "./channels/voice.mjs";
import { createAutoCompact } from "./channels/auto-compact.mjs";
import { parseAutoCompactConfig } from "./core/auto-compact.mjs";
import { createDriftGuard } from "./channels/drift-guard.mjs";
import { parseReminderConfig } from "./core/reminder-state.mjs";

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
const AGENTMUX_YAML = process.env.AGENTMUX_YAML || resolve(__dir, "agentmux.yaml");
const TIMEOUT = parseInt(process.env.TIMEOUT_S || "600") * 1000;
const WHISPER_URL = process.env.WHISPER_URL || "http://localhost:2022/v1/audio/transcriptions";
const SHELL_PATH = process.env.SHELL_PATH || `${process.env.HOME}/bin:${process.env.PATH}`;
const TMUX_SOCKET = process.env.TMUX_SOCKET || "/tmp/agentmux.sock";
const TTS_VOICE = process.env.TTS_VOICE || "sv-SE-MattiasNeural";
const STATE_FILE = process.env.STATE_FILE || "/tmp/agentmux-state.json";

// Voice PWA. Defaults to 127.0.0.1 — expose via Tailscale Serve when
// you want the phone in. Tailnet IS the auth; no token layer.
const VOICE_PWA_PORT = parseInt(process.env.VOICE_PWA_PORT || "8080");
const VOICE_PWA_HOST = process.env.VOICE_PWA_HOST || "127.0.0.1";

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

// Mutable hook so the agent can fire a resume-hint Discord-mirror without
// importing the discord channel directly. Wired up below once `discord`
// exists (createAgent runs before discord init due to dependency order).
let resumeHintMirror = null;
const agent = createAgent({
  tmuxSocket: TMUX_SOCKET,
  configPath: AGENTS_YAML,
  timeout: TIMEOUT,
  run,
  tmuxExec,
  onResumeHint: (info) => resumeHintMirror?.(info),
});
const attachments = createAttachmentHandler({
  run,
  transcribeScript: process.env.TRANSCRIBE_SCRIPT || resolve(__dir, "bin/transcribe-whisper.sh"),
  downloadBuffer,
});
const tts = createTTS({ run, state: appState, voice: TTS_VOICE });
const recorder = createRecorder({
  dir: process.env.AGENTMUX_RECORD === "1" ? resolve(__dir, "test/recordings") : null,
});
if (recorder.enabled) console.log(`recorder | enabled → ${resolve(__dir, "test/recordings")}`);

// --- Channels ---

// Stamp last-mirror ts per channel on every outbound Discord message.
// Used by handlers.postCatchupNoticeIfNeeded to detect stale channels
// (activity in pane that didn't go via Discord — e.g. typed in tmux).
function stampChannelMirror(channelId) {
  const prev = appState.get("channel_last_mirror_ts", {}) || {};
  prev[channelId] = new Date().toISOString();
  appState.set("channel_last_mirror_ts", prev);
}

const discord = createDiscordChannel({ token: TOKEN, onSent: stampChannelMirror });

// Now that discord exists, wire the agent's resume-hint hook so spawn-time
// hint injections (1.14.0) get mirrored to the bound Discord channel
// (1.16.0). Idempotent: safe to skip when no channel is bound.
import { findChannelForPane } from "./cli/config.mjs";
import { forwardReplyAsync as forwardHintReplyAsync } from "./core/reply-forwarder.mjs";
resumeHintMirror = async ({ agentName, pane, hint, paneDir }) => {
  const channelId = findChannelForPane(AGENTS_YAML, agentName, pane);
  if (!channelId) return;
  try {
    await discord.send(channelId, hint);
  } catch (err) {
    console.warn(`resume-hint mirror failed for ${agentName}:${pane}: ${err.message}`);
    return;
  }
  // Forward whatever the agent emits in response (filtered by boilerplate).
  forwardHintReplyAsync({
    agent,
    discord,
    agentName,
    pane,
    channelId,
    paneDir,
    sentAtMs: Date.now(),
    matcher: (userPrompt) => userPrompt.includes("[amux resume hint]"),
    timeoutMs: 60_000,
    log: (msg) => console.log(`resume-hint | ${msg}`),
    label: "resume-hint",
  });
};

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
  agentmuxYamlPath: AGENTMUX_YAML,
  agentsYamlPath: AGENTS_YAML,
  recorder,
});

// Voice PWA HTTP endpoint (optional). Mirror sends voice input to the
// discord channel bound to the pane so channel watchers see what came
// in via the phone — same source-of-truth principle as sendToPane.
// Auto-compact: background poll that warns + fires /compact on idle
// high-context panes. Defaults are tuned for "user left, agent idling" —
// see core/auto-compact.mjs for rationale.
const autoCompactConfig = parseAutoCompactConfig();
const autoCompact = createAutoCompact({
  agent,
  agentsYamlPath: AGENTS_YAML,
  discord,
  tmux: (cmd) => tmuxExec(`tmux -S '${TMUX_SOCKET}' ${cmd}`),
  config: autoCompactConfig,
});
autoCompact.start();

// Drift-guard: periodic reminder to panes that have accumulated many turns
// without a /compact or prior reminder. Counteracts attention-weight decay
// on long CLAUDE.md-driven rules. See core/reminder-state.mjs for the
// decision logic; threshold/enabled are env-tunable (AMUX_REMIND_*).
const driftGuardConfig = parseReminderConfig();
const driftGuard = createDriftGuard({
  agent,
  agentsYamlPath: AGENTS_YAML,
  discord,
  config: driftGuardConfig,
});
driftGuard.start();

// Static PWA bundle is served from the same Node process so the whole
// app lives behind one Tailscale Serve tunnel. Override with
// VOICE_PWA_STATIC_DIR if the PWA lives somewhere other than
// ../voice-pwa/build relative to agentmux.
const defaultStaticDir = resolve(__dir, "../voice-pwa/build");
const voicePwaStaticDir = process.env.VOICE_PWA_STATIC_DIR
  || (existsSync(defaultStaticDir) ? defaultStaticDir : null);

const voicePwa = createVoicePWA({
  port: VOICE_PWA_PORT,
  host: VOICE_PWA_HOST,
  agent,
  agentsYamlPath: AGENTS_YAML,
  transcribeScript: process.env.TRANSCRIBE_SCRIPT || resolve(__dir, "bin/transcribe-whisper.sh"),
  run,
  ttsVoice: TTS_VOICE,
  mirror: { send: (channelId, text) => discord.send(channelId, text) },
  staticDir: voicePwaStaticDir,
});
voicePwa.start()
  .then(({ url }) => {
    const staticNote = voicePwaStaticDir ? ` (PWA: ${voicePwaStaticDir})` : " (api only — build voice-pwa for the UI)";
    console.log(`voice-pwa | listening at ${url}${staticNote}`);
  })
  .catch((err) => console.error(`voice-pwa | failed to start: ${err.message}`));
