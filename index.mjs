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
import { createAgent, ensureAgentHints, HINTS_VERSION } from "./agent.mjs";
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
import { createJsonlWatcher } from "./channels/jsonl-watcher.mjs";
import { createNativeRuntimeWatcher } from "./channels/native-runtime-watcher.mjs";
import { createPlaywrightWatchdog } from "./channels/playwright-watchdog.mjs";
import { parsePlaywrightWatchdogConfig } from "./core/playwright-watchdog.mjs";
import { startHeartbeat } from "./core/heartbeat.mjs";
import { startMemoryGuard } from "./core/memory-guard.mjs";
import { readReleaseManifest } from "./core/release-identity.mjs";
import { resolveConfigSources } from "./core/config-sources.mjs";
import { syncConfiguredAgentHints } from "./core/hints-sync.mjs";
import { runPendingFleetRestart } from "./core/fleet-restart.mjs";
import { createDeliveryQueue } from "./core/delivery-queue.mjs";
import { createDeliveryBroker } from "./core/delivery-broker.mjs";
import { findChannelForPane, listAgents, validateAgentPane } from "./cli/config.mjs";
import { createNativeRuntimeClient } from "./core/native-runtime-client.mjs";
import { createAgentRouter } from "./core/agent-router.mjs";

// --- Config ---

const __dir = dirname(fileURLToPath(import.meta.url));

// Secrets/operator config resolve from the pinned external home first;
// the package-directory copy is only the migration fallback (an
// `npm install --global` replaces the whole package tree).
const configSources = resolveConfigSources({ packageDir: __dir });

function loadEnv() {
  try {
    const vars = parseEnv(readFileSync(configSources.envFile.path, "utf-8"));
    for (const [k, v] of Object.entries(vars)) {
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
}

loadEnv();

const TOKEN = process.env.DISCORD_TOKEN;
const AGENTS_YAML = process.env.AGENTS_YAML || resolve(__dir, "agents.yaml");
const AGENTMUX_YAML = configSources.agentmuxYaml.path;
const TIMEOUT = parseInt(process.env.TIMEOUT_S || "600") * 1000;
const WHISPER_URL = process.env.WHISPER_URL || "http://localhost:2022/v1/audio/transcriptions";
const SHELL_PATH = process.env.SHELL_PATH || `${process.env.HOME}/bin:${process.env.PATH}`;
// Keep the bridge on the same canonical server as the amux CLI. A divergent
// default made model-watch observe Codex through jsonl but send Escape/model
// keystrokes to a nonexistent socket.
const TMUX_SOCKET = process.env.TMUX_SOCKET || "/tmp/openclaw-claude.sock";
const TTS_VOICE = process.env.TTS_VOICE || "sv-SE-MattiasNeural";
const STATE_FILE = process.env.STATE_FILE || "/tmp/agentmux-state.json";

// Voice PWA. Defaults to 127.0.0.1 — expose via Tailscale Serve when
// you want the phone in. Tailnet IS the auth; no token layer.
const VOICE_PWA_PORT = parseInt(process.env.VOICE_PWA_PORT || "8080");
const VOICE_PWA_HOST = process.env.VOICE_PWA_HOST || "127.0.0.1";
const AMUX_REACTIVE_POKE = process.env.AMUX_REACTIVE_POKE === "1";

if (!TOKEN) {
  console.error(`Set DISCORD_TOKEN in ${configSources.envFile.path} (source: ${configSources.envFile.source})`);
  process.exit(1);
}

// Refresh every configured workspace before any pane/watcher can consume an
// older generated policy. This is the same engine exposed by `amux hints-sync`.
const startupHints = syncConfiguredAgentHints(listAgents(AGENTS_YAML), {
  ensure: ensureAgentHints,
  version: HINTS_VERSION,
});
console.log(
  `[hints-sync] v${HINTS_VERSION}: ${startupHints.workspaceRoots} workspaces, ` +
  `${startupHints.changedFiles} files updated`,
);
for (const failure of startupHints.errors) {
  console.warn(`[hints-sync] ${failure.rootDir}/${failure.file || "workspace"}: ${failure.error}`);
}

// --- Services ---

const exec = promisify(execCb);
const run = (cmd, timeoutMs = TIMEOUT) =>
  exec(cmd, { timeout: timeoutMs, env: { ...process.env, PATH: SHELL_PATH }, maxBuffer: 1024 * 1024 });
const tmuxExec = (cmd) =>
  exec(cmd, { timeout: 3000, env: { ...process.env, PATH: SHELL_PATH } });

// Liveness contract for `amux doctor` + bin/bridge-watchdog-cron.sh: a 30s
// heartbeat with pid + version. Catches what the supervisor cannot see —
// hung event loop, and a bridge running older code than the repo.
const pkgVersion = (() => {
  try { return JSON.parse(readFileSync(resolve(__dir, "package.json"), "utf-8")).version; }
  catch { return "unknown"; }
})();
const releaseManifest = readReleaseManifest(__dir);
startHeartbeat({
  version: pkgVersion,
  sourceSha: releaseManifest?.sourceSha || null,
  hintsVersion: HINTS_VERSION,
});

const appState = createState(STATE_FILE);
if (appState.get("tts") === undefined) appState.set("tts", process.env.TTS === "1");
if (appState.get("thinking") === undefined) appState.set("thinking", true);
// Clear transient flags that should never survive a bridge restart.
// `syncRunning` is in-flight only during executeSync; if a prior bridge
// crashed mid-sync the persisted true blocks every subsequent trigger
// until manually cleared. Same lock-file-on-boot reasoning as init scripts.
appState.set("syncRunning", false);

const tmuxAgent = createAgent({
  tmuxSocket: TMUX_SOCKET,
  configPath: AGENTS_YAML,
  timeout: TIMEOUT,
  run,
  tmuxExec,
  state: appState,
});
const nativeRuntime = createNativeRuntimeClient({ configPath: AGENTS_YAML });
const agent = createAgentRouter({ tmuxAgent, nativeRuntime });
const validateDeliveryTarget = (agentName, pane) =>
  validateAgentPane(AGENTS_YAML, agentName, pane);
const deliveryQueue = createDeliveryQueue({ validateTarget: validateDeliveryTarget });

// A fleet restart is deliberately executed by the replacement bridge, not
// by the requesting CLI/pane: the requester may live inside the very tmux
// session being destroyed. Consume the one-shot request before channel
// watchers start so they only ever observe the rebuilt fleet.
await runPendingFleetRestart({
  agent: tmuxAgent,
  state: appState,
  enqueueContinuation: (request) => deliveryQueue.enqueue(request),
  log: (message) => console.log(`[fleet-restart] ${message}`),
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

// Memory admission guard (T1): classifies host memory pressure into a
// durable state file and alarms on transitions only. It never kills or
// restarts anything — automatic heavy starters (post-boot revive first)
// consult it before launching. Alarms go to AMUX_MEMORY_ALERT_CHANNEL when
// configured, otherwise to the bridge log.
const memoryAlertChannel = process.env.AMUX_MEMORY_ALERT_CHANNEL || null;
startMemoryGuard({
  onTransition: async ({ from, to, state }) => {
    const text = `🧠 Minnesvakt: ${from} → ${to} (MemAvailable ${Math.round((state.sample?.memAvailableKb || 0) / 1024 / 1024 * 10) / 10} GiB, SwapFree ${Math.round((state.sample?.swapFreeKb || 0) / 1024 / 1024 * 10) / 10} GiB): nya tunga automatjobb ${to === "blocked" || to === "critical" ? "stoppas" : "tillåts"}.`;
    console.warn(`[memory-guard] ${text}`);
    if (memoryAlertChannel) {
      await discord.send(memoryAlertChannel, text).catch((error) =>
        console.warn(`[memory-guard] Discord alarm failed: ${error.message}`));
    }
  },
});

const deliveryBroker = createDeliveryBroker({
  agent,
  queue: deliveryQueue,
  validateTarget: validateDeliveryTarget,
  bridgeDir: __dir,
  resolveNotificationChannel: (job) =>
    findChannelForPane(AGENTS_YAML, job.agentName, job.pane),
  notify: async (job, state, extra = {}) => {
    const channelId = job.metadata?.channelId
      || findChannelForPane(AGENTS_YAML, job.agentName, job.pane);
    if (!channelId) throw new Error(`no Discord channel bound to ${job.agentName}:${job.pane}`);
    if (state === "stalled") {
      const behind = Number(extra?.queuedBehind || 0);
      await discord.send(
        channelId,
        "⚠️ Meddelandet skickades in till panelen men har inte fått något historikkvitto ännu " +
        "(panelen verkar upptagen med en lång tur). AMUX bevakar vidare och skickar inte om det, " +
        "för att inte skapa en dubblett." +
        (behind > 0 ? ` ${behind} meddelande(n) väntar i kö bakom det.` : ""),
      );
    } else if (state === "blocked") {
      await discord.send(
        channelId,
        "⚠️ Meddelandet är säkert köat men panelen kan inte ta emot det ännu. " +
        "Det ligger kvar över omstarter och skickas i ordning när Codex-composern är tillgänglig.",
      );
    } else if (state === "recovered") {
      await discord.send(channelId, "✅ Det tidigare blockerade kömeddelandet har nu levererats.");
    } else if (state === "unverified") {
      await discord.send(
        channelId,
        job.metadata?.deliveryAmbiguity === "submitting-fence"
          ? "⚠️ Leveransen stannade mellan den durabla submit-fencen och slutkvittot. Enter kan ha skickats; " +
            "AMUX vet inte säkert och skickar därför inte om. Kontrollera agenten och composern om instruktionen är kritisk."
          : "⚠️ Meddelandet lämnade composern men fick inget exakt historikkvitto inom en timme. " +
            "AMUX skickar inte om det eftersom det kan skapa en dubblett; kontrollera agenthistoriken om instruktionen är kritisk.",
      );
    } else if (state === "not-sent") {
      await discord.send(
        channelId,
        job.metadata?.deliveryCancellation === "sender-request"
          ? "⚠️ Meddelandet avbröts före submit och skickades inte. Composern lämnades orörd; skicka en ny instruktion om arbetet ändå behövs."
          : "⚠️ Meddelandet skickades inte. Composern förblev osäker för länge eller efter för många försök, så AMUX har stoppat automatiken " +
            "för att inte skriva över eller blanda innehåll. Kontrollera/rensa composern och skicka instruktionen igen om den fortfarande behövs.",
      );
    }
  },
  log: (message) => console.warn(`[delivery-broker] ${message}`),
});

// Resume-hints moved to bin/amux-hook.mjs SessionStart context in 1.20.52 —
// they no longer pass through the bridge, so the Discord mirror that used
// to live here fell away with the typed delivery path. The session-start
// itself still shows in `amux timeline` via the hook's ledger row.

// --- Wire up ---

const { getMapping, overrides, channelMap, reloadConfig, ready: bridgeReady } = startBot({
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
  deliveryBroker,
});

// SIGUSR1 = "run sync" trigger from the CLI (`amux sync`). Same body as
// the /sync Discord handler but without a msg.reply, see handlers.mjs
// triggerSync. Bridge has to be running (which it must be to receive a
// signal anyway), so this is the no-disruption sync path. CLI tails
// the bridge log if the user wants live progress; the result also goes
// out via Discord channel deltas as channels are renamed / created.
process.on("SIGUSR1", () => {
  handlers.triggerSync().catch((err) =>
    console.error(`SIGUSR1 sync failed: ${err.message}`),
  );
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
  deliveryBroker,
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
  deliveryBroker,
  agentsYamlPath: AGENTS_YAML,
  discord,
  config: driftGuardConfig,
});
driftGuard.start();

// Playwright-MCP watchdog: keeps visual verification reliable by reaping stale
// MCP/browser processes and sending Escape if a pane sits inside a Playwright
// tool call for too long. This preserves the "take proof screenshots" workflow
// while preventing old browser sessions from wedging future tool calls.
const playwrightWatchdogConfig = parsePlaywrightWatchdogConfig();
const playwrightWatchdog = createPlaywrightWatchdog({
  agent,
  deliveryBroker,
  agentsYamlPath: AGENTS_YAML,
  discord,
  config: playwrightWatchdogConfig,
});
playwrightWatchdog.start();

// jsonl-watcher: the single mirror path. fs.watch on each pane's project
// dir, posts every complete turn to the bound Discord channel, persistent
// state so bridge-restart resumes exactly where it left off. Replaced
// streamResponse (1.16.32), drift-guard.forwardReplyAsync (1.16.33),
// resume-hint forwarder (1.16.33), and mirror-loop (1.16.33).
const jsonlWatcher = createJsonlWatcher({
  agent,
  deliveryBroker,
  agentsYamlPath: AGENTS_YAML,
  discord,
  state: appState,
  recorder,
  tts,
});
const nativeRuntimeWatcher = createNativeRuntimeWatcher({
  nativeRuntime,
  agentsYamlPath: AGENTS_YAML,
  discord,
  state: appState,
});
// The watcher can post immediately during its startup audit. Wait until the
// Discord client and inbound reconciliation are ready so the first post does
// not fail against a cold channel cache and burn a retry cycle.
await bridgeReady;
const legacyRecovery = await handlers.recoverLegacyDeliveries(discord);
if (legacyRecovery.recovered || legacyRecovery.remaining) {
  console.log(`[delivery-recovery] queued ${legacyRecovery.recovered}, remaining ${legacyRecovery.remaining}`);
}
deliveryBroker.start();
jsonlWatcher.start();
nativeRuntimeWatcher.start();

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
  deliveryBroker,
  agentsYamlPath: AGENTS_YAML,
  transcribeScript: process.env.TRANSCRIBE_SCRIPT || resolve(__dir, "bin/transcribe-whisper.sh"),
  run,
  ttsVoice: TTS_VOICE,
  mirror: { send: (channelId, text) => discord.send(channelId, text) },
  reactivePoke: AMUX_REACTIVE_POKE
    ? ({ name, pane, dir }) => jsonlWatcher.enqueuePane(name, pane, dir)
    : null,
  staticDir: voicePwaStaticDir,
});
voicePwa.start()
  .then(({ url }) => {
    const staticNote = voicePwaStaticDir ? ` (PWA: ${voicePwaStaticDir})` : " (api only — build voice-pwa for the UI)";
    console.log(`voice-pwa | listening at ${url}${staticNote}`);
  })
  .catch((err) => console.error(`voice-pwa | failed to start: ${err.message}`));
