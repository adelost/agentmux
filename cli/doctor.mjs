// amux doctor CLI wrapper: does the real reads (procfs, tmux, config,
// heartbeats, queues) and prints the one-table health report. Every rule
// it feeds lives in core/doctor*.mjs as a pure function with injected
// observations, so this file owns I/O and nothing else.

import { execSync } from "child_process";
import { readFileSync, existsSync, statSync, readlinkSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { listAgents } from "./config.mjs";
import { isPidAlive } from "./dream.mjs";
import {
  checkBridgeProcess, checkHeartbeatHealth, checkHooksInstalled, checkReleaseIdentity, checkSupervisors, checkLedger,
  rescueBridgePidFromHeartbeat, checkBridgeMode, checkContextBridge, checkConfig, overallStatus, formatDoctorReport,
  FAIL, WARN, checkDeliveryQueue, checkNativeRuntimeFleet, checkGuardCronHeartbeats, checkSuggestionsBoard,
  checkQuotaRecoveryHealth, quotaRecoveryHealthObservation,
} from "../core/doctor.mjs";
import {
  checkTmux, checkTmuxClients, checkTmuxPaneGeometry, checkTmuxVersion, observeTmuxFleet,
} from "../core/doctor-tmux.mjs";
import { readHeartbeat } from "../core/heartbeat.mjs";
import { readGuardHeartbeats } from "../core/guard-heartbeat.mjs";
import { observeReleaseIdentity } from "../core/release-identity.mjs";
import { eventsPath } from "../core/events.mjs";
import { getContextPushed } from "../core/context.mjs";
import { panePathFor } from "../core/jsonl-reader.mjs";
import { readBridgeMode } from "../core/bridge-mode.mjs";
import { createDeliveryQueue, deliveryQueueStats } from "../core/delivery-queue.mjs";
import {
  expandHome,
  loadSuggestionsBridgeConfig,
  loadSuggestionsBridgeState,
  loadSuggestionsReadCredential,
  probeSuggestionsBoard,
} from "../core/suggestions-comment-bridge.mjs";
import { discoverNativeRuntimes } from "./native-runtime-service.mjs";

/** WHAT: Reports every silent bridge, tmux, and config failure mode in one table. WHY: Keeps operators from chasing invisible breakage across scattered logs. */
export async function cmdDoctor(ctx) {
  const home = process.env.HOME;
  const repoDir = dirname(dirname(fileURLToPath(import.meta.url)));
  // bridge process + supervision
  let pids = [], supervised = false;
  try {
    // [n]ode: the bracket keeps pgrep from matching its own sh wrapper.
    // cwd filter: only count bridges running from THIS repo (other projects
    // legitimately have their own `node index.mjs`).
    const out = execSync("pgrep -f '[n]ode( [^ ]+)* index\\.mjs' || true", { encoding: "utf-8" }).trim();
    pids = (out ? out.split("\n").map((x) => parseInt(x, 10)).filter(Boolean) : [])
      .filter((pid) => {
        try { return readlinkSync(`/proc/${pid}/cwd`) === repoDir; }
        catch { return false; }
      });
    if (pids.length) {
      const ppid = execSync(`ps -o ppid= -p ${pids[0]}`, { encoding: "utf-8" }).trim();
      const parent = execSync(`ps -o args= -p ${ppid} || true`, { encoding: "utf-8" }).trim();
      supervised = /start\.sh/.test(parent);
    }
  } catch {}
  // repo version + heartbeat
  let repoVersion = null;
  try { repoVersion = JSON.parse(readFileSync(join(repoDir, "package.json"), "utf-8")).version; }
  catch {}
  const beat = readHeartbeat();
  // A live bridge keeps the PREVIOUS install as cwd after a release swap
  // (the staging dir is renamed away), so the cwd filter above goes blind
  // right after every install. The heartbeat pid is the bridge's own
  // testimony; trust it when the process is alive and runs the bridge entry.
  pids = rescueBridgePidFromHeartbeat({
    pids, beat,
    pidAlive: isPidAlive,
    cmdline: (pid) => { try { return readFileSync("/proc/" + pid + "/cmdline", "utf-8"); } catch { return ""; } },
  });
  const guardHeartbeats = readGuardHeartbeats();
  // hooks
  let settings = null, hookFileExists = false;
  try { settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")); }
  catch {}
  hookFileExists = existsSync(join(repoDir, "bin", "amux-hook.mjs"));
  const releaseIdentity = observeReleaseIdentity({ runtimeRoot: repoDir, entryPath: process.argv[1], home, settings });

  // ledger
  let ledgerStat = null;
  try {
    const st = statSync(eventsPath());
    ledgerStat = { size: st.size, mtimeMs: st.mtimeMs };
  } catch {}

  // tmux
  let tmuxVersion = null;
  try { tmuxVersion = execSync("tmux -V", { encoding: "utf-8" }).trim(); }
  catch {}
  const tmuxFleet = await observeTmuxFleet(ctx.tmux);
  const sessions = tmuxFleet.sessions.map((session) => session.name);

  // config
  let agents = [], cfgError = null;
  try { agents = listAgents(ctx.configPath); }
  catch (err) { cfgError = err.message; }

  // Suggestions board + comment bridge. Probe the same authenticated list
  // seam as cron, then join it with cron's durable full-success timestamp.
  const suggestionsConfigPath = expandHome(process.env.AMUX_SUGGESTIONS_CONFIG
    || "~/.config/agent/suggestions-comment-bridge.yaml");
  const suggestionsConfigured = existsSync(suggestionsConfigPath);
  let suggestionsProbe = null;
  let suggestionsLastSuccessfulSyncAt = null;
  if (suggestionsConfigured) {
    try {
      const allowTestOrigin = process.env.NODE_ENV === "test"
        && process.env.AMUX_SUGGESTIONS_TEST_ORIGIN === "1";
      const suggestionsConfig = loadSuggestionsBridgeConfig(suggestionsConfigPath, { allowTestOrigin });
      const suggestionsStatePath = expandHome(process.env.AMUX_SUGGESTIONS_STATE
        || suggestionsConfig.statePath);
      const suggestionsState = loadSuggestionsBridgeState(suggestionsStatePath);
      suggestionsLastSuccessfulSyncAt = suggestionsState.lastSuccessfulSyncAt;
      const readToken = loadSuggestionsReadCredential(suggestionsConfig.credentialFile);
      suggestionsProbe = await probeSuggestionsBoard({
        config: suggestionsConfig,
        readToken,
        allowTestOrigin,
      });
    } catch (error) {
      suggestionsProbe = { ok: false, status: null, error: error.message };
    }
  }

  const nativeUrls = [...new Set(agents
    .filter((agent) => agent.backend === "native")
    .map((agent) => agent.runtimeUrl || "http://127.0.0.1:8811"))];
  let managedRuntimes = [];
  let nativeDiscoveryError = null;
  try { managedRuntimes = await discoverNativeRuntimes(); }
  catch (error) { nativeDiscoveryError = error.message; }
  const configuredRuntimes = [];
  for (const runtimeUrl of nativeUrls) {
    try {
      const response = await fetch(`${runtimeUrl.replace(/\/+$/, "")}/api/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      configuredRuntimes.push({ url: runtimeUrl, online: true, health: status });
    } catch (error) {
      configuredRuntimes.push({ url: runtimeUrl, online: false, error: error.message });
    }
  }

  // context bridge coverage: how many configured claude panes have a fresh
  // statusline push (core/context.mjs getContextPushed)
  let claudePanes = 0, pushing = 0;
  for (const a of agents) {
    if (a.backend === "native") continue;
    (a.panes || []).forEach((p, i) => {
      if (!/claude/.test(String(p?.cmd || ""))) return;
      claudePanes++;
      try {
        if (getContextPushed(panePathFor(a, i))) pushing++;
      } catch { /* counted as not pushing */ }
    });
  }

  // supervisors: start.sh processes owning THIS repo. bridge.log only ever
  // receives watchdog-spawned (nohup) supervisors' output — a fresh crash
  // tail there means an orphan is looping right now.
  let supervisorPids = [], crashLooping = false;
  try {
    const out = execSync("pgrep -f '[s]tart.sh' || true", { encoding: "utf-8" }).trim();
    supervisorPids = (out ? out.split("\n").map((x) => parseInt(x, 10)).filter(Boolean) : [])
      .filter((pid) => {
        try { return readlinkSync(`/proc/${pid}/cwd`) === repoDir; }
        catch { return false; }
      });
    const logPath = join(home, ".agentmux", "bridge.log");
    const st = statSync(logPath);
    if (Date.now() - st.mtimeMs < 5 * 60 * 1000) {
      const tail = execSync(`tail -c 4096 '${logPath}'`, { encoding: "utf-8" });
      const lines = tail.trim().split("\n");
      crashLooping = /crashed \(exit \d+\)/.test(lines[lines.length - 1] || "");
    }
  } catch { /* no log / no procs: nothing to flag */ }

  const tmuxRequired = Boolean(cfgError) || agents.some((agent) => agent.backend !== "native");
  const checks = [
    checkBridgeProcess({ pids, supervised }),
    checkBridgeMode({ mode: readBridgeMode(), running: pids.length > 0 }),
    checkSupervisors({ pids: supervisorPids, crashLooping }),
    checkReleaseIdentity(releaseIdentity),
    checkHeartbeatHealth({ beat, repoVersion, repoSourceSha: releaseIdentity.sourceSha, pidAlive: pids.length > 0 }), checkQuotaRecoveryHealth({ ...quotaRecoveryHealthObservation(createDeliveryQueue()), bridgeRunning: pids.length > 0 }),
    checkHooksInstalled({ settings, hookFileExists }),
    checkLedger({ stat: ledgerStat }),
    checkContextBridge({ claudePanes, pushing }),
    checkTmuxVersion({ version: tmuxVersion, required: tmuxRequired }),
    checkTmux({ sessions, error: tmuxFleet.error, required: tmuxRequired }),
    checkTmuxPaneGeometry({ ...tmuxFleet, required: tmuxRequired }),
    checkTmuxClients({ ...tmuxFleet, required: tmuxRequired }),
    checkConfig({ agents, error: cfgError }),
    checkSuggestionsBoard({
      configured: suggestionsConfigured,
      probe: suggestionsProbe,
      lastSuccessfulSyncAt: suggestionsLastSuccessfulSyncAt,
    }),
    ...checkNativeRuntimeFleet({
      managed: managedRuntimes,
      configured: configuredRuntimes,
      discoveryError: nativeDiscoveryError,
    }),
    checkDeliveryQueue({
      stats: deliveryQueueStats(createDeliveryQueue()),
      bridgeRunning: pids.length > 0,
    }),
    checkGuardCronHeartbeats({ heartbeats: guardHeartbeats }),
  ];

  const activeChecks = checks.filter(Boolean);
  console.log("\namux doctor\n");
  console.log(formatDoctorReport(activeChecks));
  const overall = overallStatus(activeChecks);
  console.log("");
  if (overall === FAIL) process.exit(2);
  if (overall === WARN) process.exit(1);
}
