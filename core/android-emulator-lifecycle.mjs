import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canStartHeavy, classifyMemory, parseMeminfo } from "./memory-guard.mjs";
import { formatMemoryRelief, relieveIdleGradleDaemons } from "./memory-relief.mjs";

/** WHAT: Defines the default guest-idle budget. WHY: Keeps headless emulators from consuming RAM indefinitely. */
export const DEFAULT_ANDROID_EMULATOR_IDLE_MS = 60 * 60_000;
/** WHAT: Defines the second-observation delay. WHY: Keeps one stale sample from stopping an active emulator. */
export const DEFAULT_ANDROID_EMULATOR_CONFIRM_MS = 5 * 60_000;
/** WHAT: Names the durable lifecycle ledger. WHY: Keeps arming and wake identity stable across cron runs. */
export const DEFAULT_ANDROID_EMULATOR_STATE = join(homedir(), ".agentmux", "android-emulator-guard.json");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// One headless guest measured 3.0-3.9 GiB on 2026-09-14.
const EMULATOR_BOOT_RESERVE_MIB = 4096;

/** WHAT: Checks a cold boot against a live memory sample. WHY: Prevents a new guest from pushing the host into the level that refuses pane wakes. */
export async function admitEmulatorBootFromMeminfo({ readMeminfo = () => readFileSync("/proc/meminfo", "utf8") } = {}) {
  const sample = parseMeminfo(readMeminfo());
  const verdict = canStartHeavy({ observedAt: Date.now(), level: classifyMemory(sample), sample }, {
    class: "emulator", reserveMiB: EMULATOR_BOOT_RESERVE_MIB, bootId: null,
  });
  const gib = (kb) => (kb / 1024 / 1024).toFixed(1);
  return { ...verdict, detail: `MemAvailable ${gib(sample.memAvailableKb)} GiB, swap free ${gib(sample.swapFreeKb || 0)} GiB` };
}

async function relieveIdleBuildDaemons() {
  return formatMemoryRelief(await relieveIdleGradleDaemons());
}

/** WHAT: Parses stable ps columns. WHY: Keeps discovery independent of locale-sensitive process formatting. */
export function parseProcessRows(text) {
  return String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), elapsedSeconds: Number(match[2]), command: match[3] }));
}

/** WHAT: Builds a headless emulator environment without display handles. WHY: Prevents stale WSLg sockets from blocking startup. */
export function headlessEmulatorEnv(env = process.env) {
  const { DISPLAY: _display, WAYLAND_DISPLAY: _wayland, ...rest } = env;
  return rest;
}

/** WHAT: Extracts AVD identity from one process. WHY: Keeps the guard limited to agent-owned headless emulators. */
export function parseHeadlessEmulator(row) {
  const command = String(row?.command || "");
  if (!/qemu-system-[^\s]*|\/emulator(?:\s|$)/u.test(command) || !/(?:^|\s)-no-window(?:\s|$)/u.test(command)) return null;
  const avd = command.match(/(?:^|\s)-avd\s+([^\s]+)/u)?.[1];
  const portText = command.match(/(?:^|\s)-port\s+(\d+)/u)?.[1];
  if (!avd || !portText) return null;
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return {
    pid: row.pid,
    elapsedSeconds: row.elapsedSeconds,
    command,
    avd,
    port,
    serial: `emulator-${port}`,
  };
}

/** WHAT: Collects ordered headless emulator processes. WHY: Keeps status and reaping deterministic. */
export function headlessEmulatorsFromRows(rows) {
  return rows.map(parseHeadlessEmulator).filter(Boolean).sort((a, b) => a.port - b.port);
}

/** WHAT: Calculates guest inactivity from Android clocks. WHY: Keeps process age from masquerading as user idleness. */
export function parseGuestIdle(powerText, uptimeText) {
  const values = [...String(powerText || "").matchAll(/mLastUserActivityTime(?:\(excludingAttention\))?=(\d+)/gu)]
    .map((match) => Number(match[1]))
    .filter(Number.isFinite);
  const uptimeSeconds = Number.parseFloat(String(uptimeText || "").trim().split(/\s+/u)[0]);
  if (!values.length || !Number.isFinite(uptimeSeconds)) throw new Error("guest-idle-signal-unavailable");
  const uptimeMs = Math.floor(uptimeSeconds * 1000);
  const lastUserActivityMs = Math.max(...values);
  if (lastUserActivityMs < 0 || lastUserActivityMs > uptimeMs + 5_000) throw new Error("guest-idle-signal-invalid");
  return { uptimeMs, lastUserActivityMs, idleMs: Math.max(0, uptimeMs - lastUserActivityMs) };
}

/** WHAT: Filters live ADB and Gradle clients. WHY: Keeps the guard from racing an active proof or build. */
export function blockingAndroidHostWork(rows, ownPid = process.pid) {
  return rows.filter((row) => {
    if (row.pid === ownPid) return false;
    const command = row.command;
    if (/(?:^|\s)(?:\S*\/)?adb(?:\s|$)/u.test(command) && !/fork-server\s+server/u.test(command)) return true;
    if (/GradleWrapperMain|GradleWorkerMain|org\.gradle\.launcher\.cli\.RunBuildAction/u.test(command)) return true;
    return false;
  });
}

/** WHAT: Reads the durable lifecycle ledger. WHY: Keeps corrupt state fail-closed instead of silently reaping. */
export function readAndroidEmulatorState(path = DEFAULT_ANDROID_EMULATOR_STATE) {
  if (!existsSync(path)) return { version: 1, emulators: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== 1 || !parsed.emulators || typeof parsed.emulators !== "object") throw new Error("invalid state");
    return parsed;
  } catch (error) {
    throw new Error(`android emulator guard state is unreadable: ${error.message}`);
  }
}

/** WHAT: Stores lifecycle state atomically. WHY: Keeps cron interruption from fabricating an idle receipt. */
export function writeAndroidEmulatorState(state, path = DEFAULT_ANDROID_EMULATOR_STATE) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}

/** WHAT: Resolves exact Android binaries. WHY: Keeps sanitized cron PATHs from disabling the guard. */
export function resolveAndroidTools(env = process.env) {
  const sdk = env.ANDROID_SDK || env.ANDROID_HOME || join(homedir(), "android-dev", "sdk");
  return {
    adb: env.AMUX_ANDROID_ADB || join(sdk, "platform-tools", "adb"),
    emulator: env.AMUX_ANDROID_EMULATOR || join(sdk, "emulator", "emulator"),
  };
}

/** WHAT: Reads current host processes. WHY: Keeps stop decisions grounded in the final live process set. */
export function readProcessRows() {
  return parseProcessRows(execFileSync("ps", ["-eo", "pid=,etimes=,args="], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
}

/** WHAT: Reads one emulator's guest activity clocks. WHY: Keeps the idle decision tied to actual Android interaction. */
export function readGuestIdle(serial, { adb = resolveAndroidTools().adb, exec = execFileSync } = {}) {
  const options = { encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024 };
  const power = exec(adb, ["-s", serial, "shell", "dumpsys", "power"], options);
  const uptime = exec(adb, ["-s", serial, "shell", "cat", "/proc/uptime"], options);
  return parseGuestIdle(power, uptime);
}

// Names adb can know one emulator by: its console serial, or its adb port after `adb connect`.
function adbNamesFor(emulator) {
  return [emulator.serial, `localhost:${emulator.port + 1}`, `127.0.0.1:${emulator.port + 1}`];
}

/** WHAT: Reads an emulator's best adb state from `adb devices`. WHY: Separates an emulator adb cannot reach from one whose idle signal is only missing. */
export function readAdbDeviceState(emulator, { adb = resolveAndroidTools().adb, exec = execFileSync } = {}) {
  const listing = exec(adb, ["devices"], { encoding: "utf8", timeout: 10_000 });
  const names = new Set(adbNamesFor(emulator));
  const states = String(listing).split(/\r?\n/u).map((line) => line.trim().split(/\s+/u))
    .filter(([name]) => names.has(name)).map(([, state]) => state);
  return states.includes("device") ? "device" : states[0] || "absent";
}

/** WHAT: Collects other processes that name an emulator by any adb name. WHY: Keeps a waiting adb client or test from losing its emulator. */
export function processesNamingEmulator(rows, emulator) {
  const names = adbNamesFor(emulator).map((name) => name.replaceAll(".", "\\."));
  const pattern = new RegExp(`(?:^|[\\s=])(?:${names.join("|")})(?:\\s|$)`, "u");
  return rows.filter((row) => pattern.test(row.command));
}

/** WHAT: Dispatches an identity-bound SIGTERM to an emulator adb cannot reach. WHY: Keeps a wedged guest from holding its memory when `adb emu kill` has no device to talk to. */
export async function terminateUnreachableAndroidEmulator(emulator, {
  readRows = readProcessRows,
  kill = (pid) => process.kill(pid, "SIGTERM"),
  wait = sleep,
  verifyTimeoutMs = 30_000,
} = {}) {
  if (!currentProcessMatches(emulator, readRows())) return { stopped: false, reason: "process-identity-changed" };
  try {
    kill(emulator.pid);
  } catch (error) {
    return { stopped: false, reason: `terminate-failed:${error.code || error.message}` };
  }
  const deadline = Date.now() + verifyTimeoutMs;
  while (Date.now() < deadline) {
    if (!currentProcessMatches(emulator, readRows())) return { stopped: true };
    await wait(250);
  }
  return { stopped: false, reason: "terminate-exit-not-observed" };
}

function effectiveIdleMs(guestIdleMs, entry, now) {
  if (!Number.isFinite(entry?.lastUseAt)) return guestIdleMs;
  return Math.min(guestIdleMs, Math.max(0, now - entry.lastUseAt));
}

function currentProcessMatches(emulator, rows) {
  const current = rows.find((row) => row.pid === emulator.pid);
  const parsed = current && parseHeadlessEmulator(current);
  return !!parsed && parsed.avd === emulator.avd && parsed.port === emulator.port;
}

/** WHAT: Dispatches and verifies an identity-bound graceful stop. WHY: Keeps auto-cleanup from using broad or forceful kills. */
export async function gracefulStopAndroidEmulator(emulator, {
  adb = resolveAndroidTools().adb,
  exec = execFileSync,
  readRows = readProcessRows,
  wait = sleep,
  verifyTimeoutMs = 15_000,
} = {}) {
  if (!currentProcessMatches(emulator, readRows())) return { stopped: false, reason: "process-identity-changed" };
  try {
    exec(adb, ["-s", emulator.serial, "emu", "kill"], { encoding: "utf8", timeout: 10_000 });
  } catch (error) {
    return { stopped: false, reason: `graceful-exit-failed:${error.message}` };
  }
  const deadline = Date.now() + verifyTimeoutMs;
  while (Date.now() < deadline) {
    if (!currentProcessMatches(emulator, readRows())) return { stopped: true };
    await wait(250);
  }
  return { stopped: false, reason: "graceful-exit-not-observed" };
}

// adb states that no client can drive: the serial is gone or offline.
function unreachableAdbState(readAdbState, emulator) {
  let adbState;
  try {
    adbState = readAdbState(emulator);
  } catch {
    return null;
  }
  return adbState === "absent" || adbState === "offline" ? adbState : null;
}

/** WHAT: Schedules every emulator for idle arming or stop. WHY: Keeps reaping bounded, durable and two-observation safe. */
export async function sweepAndroidEmulators({
  now = Date.now(),
  idleMs = DEFAULT_ANDROID_EMULATOR_IDLE_MS,
  confirmMs = DEFAULT_ANDROID_EMULATOR_CONFIRM_MS,
  dryRun = false,
  onlyAvd = null,
  statePath = DEFAULT_ANDROID_EMULATOR_STATE,
  rows = null,
  readRows = readProcessRows,
  readIdle = readGuestIdle,
  stop = gracefulStopAndroidEmulator,
  readAdbState = readAdbDeviceState,
  stopUnreachable = terminateUnreachableAndroidEmulator,
} = {}) {
  const processRows = rows || readRows();
  const emulators = headlessEmulatorsFromRows(processRows)
    .filter((emulator) => !onlyAvd || emulator.avd === onlyAvd);
  const blockers = blockingAndroidHostWork(processRows);
  const state = readAndroidEmulatorState(statePath);
  const results = [];
  const seenAvds = new Set();

  for (const emulator of emulators) {
    seenAvds.add(emulator.avd);
    const previous = state.emulators[emulator.avd] || {};
    const entry = {
      ...previous,
      avd: emulator.avd,
      serial: emulator.serial,
      port: emulator.port,
      pid: emulator.pid,
      lastSeenAt: now,
      status: "awake",
    };
    const sameGeneration = previous.pid === emulator.pid && previous.serial === emulator.serial;
    let guest;
    try {
      guest = readIdle(emulator.serial);
    } catch (error) {
      entry.armedAt = null;
      entry.blockedReason = `observation-failed:${error.message}`;
      entry.observationFailedSince = sameGeneration && Number.isFinite(previous.observationFailedSince)
        ? previous.observationFailedSince
        : now;
      const unreachable = !dryRun && now - entry.observationFailedSince >= idleMs
        && !processesNamingEmulator(processRows, emulator).length
        ? unreachableAdbState(readAdbState, emulator)
        : null;
      if (!unreachable) {
        state.emulators[emulator.avd] = entry;
        results.push({ ...emulator, action: "blocked", reason: entry.blockedReason });
        continue;
      }
      const stopReason = `adb-unreachable-${unreachable}`;
      const outcome = await stopUnreachable(emulator);
      if (outcome.stopped) {
        state.emulators[emulator.avd] = { ...entry, pid: null, status: "asleep", stoppedAt: Date.now(), stopReason };
        results.push({ ...emulator, action: "stopped", reason: stopReason });
      } else {
        entry.blockedReason = `${stopReason}:${outcome.reason}`;
        state.emulators[emulator.avd] = entry;
        results.push({ ...emulator, action: "blocked", reason: entry.blockedReason });
      }
      continue;
    }

    const observedIdleMs = effectiveIdleMs(guest.idleMs, entry, now);
    entry.guestIdleMs = guest.idleMs;
    entry.observedIdleMs = observedIdleMs;
    entry.blockedReason = null;
    entry.observationFailedSince = null;
    if (observedIdleMs < idleMs) {
      entry.armedAt = null;
      state.emulators[emulator.avd] = entry;
      results.push({ ...emulator, action: "keep", idleMs: observedIdleMs, reason: "recent-guest-activity" });
      continue;
    }
    if (blockers.length) {
      entry.armedAt = null;
      entry.blockedReason = "android-host-work-active";
      state.emulators[emulator.avd] = entry;
      results.push({ ...emulator, action: "keep", idleMs: observedIdleMs, reason: entry.blockedReason, blockers });
      continue;
    }

    if (!sameGeneration || !Number.isFinite(previous.armedAt)) {
      entry.armedAt = now;
      entry.status = "arming";
      state.emulators[emulator.avd] = entry;
      results.push({ ...emulator, action: dryRun ? "would-arm" : "arm", idleMs: observedIdleMs });
      continue;
    }
    entry.armedAt = previous.armedAt;
    entry.status = "arming";
    if (now - previous.armedAt < confirmMs) {
      state.emulators[emulator.avd] = entry;
      results.push({ ...emulator, action: "confirming", idleMs: observedIdleMs, confirmRemainingMs: confirmMs - (now - previous.armedAt) });
      continue;
    }
    if (dryRun) {
      state.emulators[emulator.avd] = entry;
      results.push({ ...emulator, action: "would-stop", idleMs: observedIdleMs });
      continue;
    }

    const outcome = await stop(emulator);
    if (outcome.stopped) {
      state.emulators[emulator.avd] = {
        ...entry,
        pid: null,
        armedAt: null,
        status: "asleep",
        stoppedAt: Date.now(),
        stopReason: "idle-timeout",
      };
      results.push({ ...emulator, action: "stopped", idleMs: observedIdleMs });
    } else {
      entry.status = "blocked";
      entry.blockedReason = outcome.reason || "graceful-exit-failed";
      state.emulators[emulator.avd] = entry;
      results.push({ ...emulator, action: "blocked", idleMs: observedIdleMs, reason: entry.blockedReason });
    }
  }

  for (const [avd, entry] of Object.entries(state.emulators)) {
    if (!seenAvds.has(avd) && entry.status !== "asleep") {
      state.emulators[avd] = { ...entry, pid: null, armedAt: null, status: "asleep", lastSeenAt: now };
    }
  }
  if (!dryRun) writeAndroidEmulatorState(state, statePath);
  return { idleMs, confirmMs, dryRun, blockers, results, state };
}

/** WHAT: Stores explicit emulator use. WHY: Keeps a newly requested AVD awake for a complete work interval. */
export function touchAndroidEmulator(avd, {
  now = Date.now(),
  statePath = DEFAULT_ANDROID_EMULATOR_STATE,
} = {}) {
  const state = readAndroidEmulatorState(statePath);
  const current = state.emulators[avd] || { avd };
  state.emulators[avd] = { ...current, lastUseAt: now, armedAt: null, blockedReason: null };
  writeAndroidEmulatorState(state, statePath);
  return state.emulators[avd];
}

/** WHAT: Resolves or boots an exact AVD and stores its wake lease. WHY: Keeps sleeping AVDs from requiring manual recovery. */
export async function ensureAndroidEmulator(avd, {
  port = null,
  waitForBoot = true,
  bootTimeoutMs = 300_000,
  statePath = DEFAULT_ANDROID_EMULATOR_STATE,
  tools = resolveAndroidTools(),
  readRows = readProcessRows,
  exec = execFileSync,
  spawnProcess = spawn,
  wait = sleep,
  now = Date.now(),
  logPath = null,
  admitBoot = admitEmulatorBootFromMeminfo,
  relieve = relieveIdleBuildDaemons,
} = {}) {
  if (!/^[A-Za-z0-9._-]+$/u.test(String(avd || ""))) throw new Error("AVD name must contain only letters, digits, dot, underscore or dash");
  const state = readAndroidEmulatorState(statePath);
  const known = state.emulators[avd] || {};
  const selectedPort = Number(port || known.port);
  if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65_535) {
    throw new Error(`no known port for ${avd}; pass --port once`);
  }
  const serial = `emulator-${selectedPort}`;
  const running = headlessEmulatorsFromRows(readRows());
  const exact = running.find((item) => item.avd === avd && item.port === selectedPort);
  if (exact) {
    state.emulators[avd] = {
      ...known,
      avd,
      port: selectedPort,
      serial,
      pid: exact.pid,
      status: "awake",
      lastUseAt: now,
      armedAt: null,
      blockedReason: null,
    };
    writeAndroidEmulatorState(state, statePath);
    return { avd, port: selectedPort, serial, pid: exact.pid, reused: true, booted: true };
  }
  const collision = running.find((item) => item.port === selectedPort);
  if (collision) throw new Error(`port ${selectedPort} is already owned by AVD ${collision.avd}`);
  const avds = String(exec(tools.emulator, ["-list-avds"], { encoding: "utf8", timeout: 10_000 }))
    .split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (!avds.includes(avd)) throw new Error(`AVD ${avd} is not installed`);
  let admission = await admitBoot();
  if (!admission.ok) {
    const relief = await relieve();
    admission = await admitBoot();
    if (!admission.ok) {
      throw new Error(`memory guard refused booting ${avd}: ${admission.reason}${admission.detail ? ` (${admission.detail})` : ""}; relief: ${relief}. Stop an emulator you are done with (amux emulator reap) or retry after builds finish.`);
    }
  }

  if (!existsSync(tools.emulator)) throw new Error(`Android emulator executable not found at ${tools.emulator}`);
  const outputPath = logPath || join(homedir(), ".agentmux", `android-emulator-${selectedPort}.log`);
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  const fd = openSync(outputPath, "a", 0o600);
  let child;
  try {
    child = spawnProcess(tools.emulator, [
      "-avd", avd,
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-no-snapshot-load",
      "-gpu", "swiftshader_indirect",
      "-port", String(selectedPort),
    ], { detached: true, stdio: ["ignore", fd, fd], env: headlessEmulatorEnv() });
  } finally {
    closeSync(fd);
  }
  child.unref?.();
  state.emulators[avd] = {
    ...known,
    avd,
    port: selectedPort,
    serial,
    pid: child.pid || null,
    status: "starting",
    lastUseAt: now,
    armedAt: null,
    startedAt: now,
  };
  writeAndroidEmulatorState(state, statePath);
  if (!waitForBoot) return { avd, port: selectedPort, serial, pid: child.pid, reused: false, booted: false, logPath: outputPath };

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const booted = String(exec(tools.adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], {
        encoding: "utf8", timeout: 5_000,
      })).trim();
      if (booted === "1") {
        touchAndroidEmulator(avd, { now: Date.now(), statePath });
        return { avd, port: selectedPort, serial, pid: child.pid, reused: false, booted: true, logPath: outputPath };
      }
    } catch { /* device is still booting */ }
    await wait(1_000);
  }
  throw new Error(`${serial} did not finish booting within ${Math.round(bootTimeoutMs / 1000)}s; inspect ${outputPath}`);
}

/** WHAT: Formats one bounded sweep. WHY: Keeps cleanup decisions visible without exposing raw process dumps. */
export function formatAndroidEmulatorSweep(result) {
  const limitMinutes = Math.round(result.idleMs / 60_000);
  if (!result.results.length) return `android-emulator-guard: no running headless emulators (idle limit ${limitMinutes}m)`;
  const summary = result.results.map((item) => {
    const idle = Number.isFinite(item.idleMs) ? `${Math.floor(item.idleMs / 60_000)}m idle` : "idle unknown";
    const reason = item.reason ? `, ${item.reason}` : "";
    return `  ${item.serial}\t${item.avd}\tpid ${item.pid}\t${idle}\t${item.action}${reason}`;
  });
  return [`android-emulator-guard: ${result.results.length} headless emulator(s), idle limit ${limitMinutes}m`, ...summary].join("\n");
}
