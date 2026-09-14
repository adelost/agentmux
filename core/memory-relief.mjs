// Memory pressure relief: frees memory held by build daemons their own tool
// reports as IDLE. It never guesses from CPU or age, and it never touches a
// daemon that is building. 2026-09-14: idle Gradle daemons held 21 GiB at
// 20:20 and 13 GiB at 21:17, and both times blocked every pane wake.

import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { startMemoryGuard } from "./memory-guard.mjs";

const GRADLE_DAEMON = /\sorg\.gradle\.launcher\.daemon\.bootstrap\.GradleDaemon (\d+(?:\.\d+)+)(?:\s|$)/u;
const STATUS_ROW = /^\s*(\d+)\s+(IDLE|BUSY|STOPPED|CANCELED|\S+)\s+(\d+(?:\.\d+)+)/u;

/** WHAT: Parses running Gradle daemons from `ps -eo pid=,rss=,args=` rows. WHY: Keeps version, JVM and size together for one relief decision. */
export function gradleDaemonsFromPs(text) {
  const daemons = [];
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)(.*)$/u);
    if (!match) continue;
    const version = `${match[3]}${match[4]}`.match(GRADLE_DAEMON)?.[1];
    if (!version) continue;
    daemons.push({ pid: Number(match[1]), rssKb: Number(match[2]), java: match[3], version });
  }
  return daemons;
}

/** WHAT: Parses `gradle --status` into pid to state. WHY: Keeps Gradle's own IDLE verdict as the only proof a daemon may stop. */
export function parseGradleStatus(text) {
  const states = new Map();
  for (const line of String(text || "").split("\n")) {
    const match = line.match(STATUS_ROW);
    if (match) states.set(Number(match[1]), { state: match[2], version: match[3] });
  }
  return states;
}

/** WHAT: Resolves the installed Gradle launcher for one version. WHY: Separates distribution lookup from the stop decision. */
export function findGradleLauncher(version, { gradleHome = join(homedir(), ".gradle") } = {}) {
  const dists = join(gradleHome, "wrapper", "dists");
  if (!existsSync(dists)) return null;
  for (const flavor of readdirSync(dists).filter((name) => name.startsWith(`gradle-${version}-`))) {
    for (const hash of readdirSync(join(dists, flavor))) {
      const launcher = join(dists, flavor, hash, `gradle-${version}`, "bin", "gradle");
      if (existsSync(launcher)) return launcher;
    }
  }
  return null;
}

function runGradleStatus(launcher, javaHome) {
  return new Promise((resolvePromise) => {
    execFile(launcher, ["--status", "--offline", "-q"], {
      cwd: tmpdir(),
      env: { ...process.env, JAVA_HOME: javaHome },
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => resolvePromise({ ok: !error, stdout: String(stdout || "") }));
  });
}

function readPs() {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile("ps", ["-eo", "pid=,rss=,args="], { maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      (error ? rejectPromise(error) : resolvePromise(String(stdout))));
  });
}

function isStillGradleDaemon(pid) {
  try {
    return GRADLE_DAEMON.test(` ${readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ")}`);
  } catch {
    return false;
  }
}

/** WHAT: Dispatches SIGTERM to the Gradle daemons Gradle reports IDLE. WHY: Prevents idle build daemons from blocking pane wakes and emulator boots. */
export async function relieveIdleGradleDaemons({
  listProcesses = readPs,
  statusFor = runGradleStatus,
  launcherFor = findGradleLauncher,
  stillDaemon = isStillGradleDaemon,
  kill = (pid) => process.kill(pid, "SIGTERM"),
} = {}) {
  const daemons = gradleDaemonsFromPs(await listProcesses());
  const result = { stopped: [], kept: [], skipped: [] };
  for (const version of [...new Set(daemons.map((daemon) => daemon.version))]) {
    const group = daemons.filter((daemon) => daemon.version === version);
    const launcher = launcherFor(version);
    if (!launcher) {
      result.skipped.push({ version, reason: "launcher-not-installed" });
      continue;
    }
    const status = await statusFor(launcher, dirname(dirname(group[0].java)));
    if (!status.ok) {
      result.skipped.push({ version, reason: "status-failed" });
      continue;
    }
    const states = parseGradleStatus(status.stdout);
    for (const daemon of group) {
      const state = states.get(daemon.pid)?.state || "UNREPORTED";
      if (state !== "IDLE" || !stillDaemon(daemon.pid)) {
        result.kept.push({ pid: daemon.pid, version, state });
        continue;
      }
      try {
        kill(daemon.pid);
        result.stopped.push({ pid: daemon.pid, version, rssKb: daemon.rssKb });
      } catch (error) {
        result.kept.push({ pid: daemon.pid, version, state: `kill-failed:${error.code || error.message}` });
      }
    }
  }
  return result;
}

/** WHAT: Formats one relief pass for the operator. WHY: Keeps the alert short and names what was freed and what was left running. */
export function formatMemoryRelief(result) {
  const freedGiB = result.stopped.reduce((sum, daemon) => sum + daemon.rssKb, 0) / 1024 / 1024;
  const stopped = result.stopped.length
    ? `stoppade ${result.stopped.length} inaktiva Gradle-processer (${freedGiB.toFixed(1)} GiB)`
    : "inga inaktiva Gradle-processer att stoppa";
  const busy = result.kept.filter((daemon) => daemon.state === "BUSY").length;
  return busy ? `${stopped}, ${busy} bygger och får vara` : stopped;
}

const gibText = (kb) => Math.round((kb || 0) / 1024 / 1024 * 10) / 10;

/** WHAT: Schedules the bridge's memory guard with its alarm and relief. WHY: Keeps pressure policy out of the bridge entry point. */
export function startBridgeMemoryGuard({ discord = null, alertChannel = null, log = console.warn, relieve = relieveIdleGradleDaemons, ...guardOptions } = {}) {
  const notify = async (text, reason) => {
    log(`[memory-guard] ${text}`);
    if (alertChannel && discord) {
      await discord.send(alertChannel, text).catch((error) => log(`[memory-guard] Discord ${reason} failed: ${error.message}`));
    }
  };
  // Alarms go to AMUX_MEMORY_ALERT_CHANNEL when configured, otherwise to the bridge log.
  return startMemoryGuard({
    ...guardOptions,
    onTransition: ({ from, to, state }) => notify(
      `🧠 Minnesvakt: ${from} → ${to} (MemAvailable ${gibText(state.sample?.memAvailableKb)} GiB, SwapFree ${gibText(state.sample?.swapFreeKb)} GiB): nya tunga automatjobb ${to === "blocked" || to === "critical" ? "stoppas" : "tillåts"}.`,
      "alarm",
    ),
    onPressure: async () => {
      const relief = await relieve();
      const text = `🧠 Minnesvakt: ${formatMemoryRelief(relief)}.`;
      if (relief.stopped.length) await notify(text, "relief notice");
      else log(`[memory-guard] ${text}`);
    },
  });
}
