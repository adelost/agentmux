// Bridge process lifecycle for the CLI. Foreground is the normal path;
// detached ownership uses a tmux-free, identity-proven supervisor.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hasSession, killSession } from "./tmux.mjs";
import {
  BRIDGE_MODE_MANAGED,
  BRIDGE_MODE_MANUAL,
  BRIDGE_MODE_STOPPED,
  bridgeModePath,
  resolveServeMode,
  writeBridgeMode,
} from "../core/bridge-mode.mjs";

const LEGACY_BRIDGE_SESSION = "amux";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * WHAT: Routes foreground, detached, readiness, and stop behavior for the Discord bridge.
 * WHY: Keeps bridge process policy out of the general command dispatcher.
 */
export function createBridgeLifecycle({ bridgeDir, env = process.env } = {}) {
  const resolvedBridgeDir = resolve(bridgeDir);
  const pidfile = () => env.PIDFILE || "/tmp/agentmux.pid";
  const readyFile = () => env.READY_FILE || "/tmp/agentmux.ready";
  const serviceRoot = () => resolve(env.AMUX_BRIDGE_SERVICE_DIR || join(env.HOME || homedir(), ".agentmux", "bridge-service"));
  const serviceRecordPath = () => join(serviceRoot(), "process.json");
  const serviceLogPath = () => resolve(env.AMUX_BRIDGE_LOG || join(env.HOME || homedir(), ".agentmux", "bridge.log"));
  const writeMode = (mode) => writeBridgeMode(mode, { path: bridgeModePath(env) });

  const readServiceRecord = () => {
    try { return JSON.parse(readFileSync(serviceRecordPath(), "utf8")); }
    catch { return null; }
  };

  const processAlive = (value) => {
    const processId = Number(value);
    if (!Number.isSafeInteger(processId) || processId <= 0) return false;
    try { process.kill(processId, 0); return true; }
    catch (error) { return error?.code === "EPERM"; }
  };

  /** WHAT: Proves detached supervisor ownership. WHY: A stale reused PID must never let amux signal an unrelated process. */
  const serviceRecordMatches = (record) => {
    if (!record?.serviceId || !processAlive(record.pid)) return false;
    try {
      const processEnvironment = readFileSync(`/proc/${Number(record.pid)}/environ`, "utf8").split("\0");
      const cwd = readlinkSync(`/proc/${Number(record.pid)}/cwd`);
      return processEnvironment.includes(`AMUX_BRIDGE_SUPERVISOR_ID=${record.serviceId}`)
        && resolve(cwd) === resolvedBridgeDir
        && resolve(record.bridgeDir) === resolvedBridgeDir;
    } catch {
      return false;
    }
  };

  const writeServiceRecord = (record) => {
    mkdirSync(serviceRoot(), { recursive: true, mode: 0o700 });
    const temporary = `${serviceRecordPath()}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, serviceRecordPath());
  };

  const clearServiceRecord = (expected = null) => {
    const current = readServiceRecord();
    if (expected && (current?.serviceId !== expected.serviceId || Number(current?.pid) !== Number(expected.pid))) return false;
    try { unlinkSync(serviceRecordPath()); } catch {}
    return true;
  };

  /** WHAT: Resolves the live bridge pid. WHY: Keeps stale pidfiles from masquerading as a running bridge. */
  function pid() {
    try {
      const value = parseInt(readFileSync(pidfile(), "utf-8").trim());
      if (!value) return null;
      process.kill(value, 0);
      return value;
    } catch {
      return null;
    }
  }

  /** WHAT: Reports whether the bridge process exists. WHY: Separates process truth from optional supervisor ownership. */
  function isAlive() {
    return pid() !== null;
  }

  /** WHAT: Reports whether Discord startup completed. WHY: Keeps pid creation from being mistaken for service readiness. */
  function isReady() {
    const livePid = pid();
    if (!livePid) return false;
    try {
      return parseInt(readFileSync(readyFile(), "utf-8").trim()) === livePid;
    } catch {
      return false;
    }
  }

  /** WHAT: Waits for the bridge readiness marker. WHY: Keeps launch commands honest during slow Discord startup. */
  async function waitUntilReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (isReady()) return true;
      await sleep(100);
    }
    return false;
  }

  /** WHAT: Clears stale pid and readiness markers. WHY: Keeps WSL pid reuse from blocking a fresh launch. */
  function clearRuntimeState() {
    try { unlinkSync(pidfile()); } catch {}
    try { unlinkSync(readyFile()); } catch {}
  }

  /** WHAT: Signals the process named by the pidfile. WHY: Lets start.sh observe a clean child stop before markers are removed. */
  function signalBridge() {
    const livePid = pid();
    if (!livePid) return false;
    try { process.kill(livePid, "SIGTERM"); return true; }
    catch { return false; }
  }

  async function waitUntilStopped(processId, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && processAlive(processId)) await sleep(100);
    return !processAlive(processId);
  }

  /** WHAT: Stops only an identity-proven detached supervisor group. WHY: Prevents PID reuse from turning cleanup into an arbitrary kill. */
  async function stopManagedSupervisor({ force = false } = {}) {
    const record = readServiceRecord();
    if (!record) return { found: false, stopped: false };
    if (!serviceRecordMatches(record)) {
      if (!processAlive(record.pid)) clearServiceRecord(record);
      return { found: true, stopped: false, stale: !processAlive(record.pid) };
    }
    const assertOwned = () => {
      const current = readServiceRecord();
      if (Number(current?.pid) !== Number(record.pid) || current?.serviceId !== record.serviceId || !serviceRecordMatches(current)) {
        throw new Error(`bridge supervisor ownership changed; refusing to signal pid ${record.pid}`);
      }
    };
    assertOwned();
    process.kill(-Number(record.pid), "SIGTERM");
    if (!await waitUntilStopped(record.pid)) {
      if (!force) throw new Error(`bridge supervisor pid ${record.pid} did not stop cleanly`);
      assertOwned();
      process.kill(-Number(record.pid), "SIGKILL");
      await waitUntilStopped(record.pid, 1_000);
    }
    clearServiceRecord(record);
    return { found: true, stopped: true };
  }

  const managedSupervisorAlive = () => serviceRecordMatches(readServiceRecord());

  const tailManagedLog = () => {
    try {
      const content = readFileSync(serviceLogPath(), "utf8");
      return content.split("\n").slice(-50).join("\n").trim();
    } catch {
      return "";
    }
  };

  /** WHAT: Runs the bridge under the visible terminal. WHY: Makes logs and Ctrl+C the default ownership experience. */
  async function startForeground(ctx) {
    clearRuntimeState();
    writeMode(BRIDGE_MODE_MANUAL);
    console.log("Bridge running in this terminal. Ctrl+C stops it; use 'amux doctor' from another terminal to inspect it.\n");
    const child = spawn("bash", ["bin/start.sh"], { cwd: ctx.bridgeDir || resolvedBridgeDir, stdio: "inherit" });
    return new Promise((resolveChild, rejectChild) => {
      child.once("error", rejectChild);
      child.once("exit", (code) => {
        if (code && code !== 130) process.exitCode = code;
        resolveChild();
      });
    });
  }

  /** WHAT: Starts start.sh in an owned detached process group. WHY: Managed bridge uptime must not depend on tmux. */
  async function startManaged() {
    clearRuntimeState();
    mkdirSync(serviceRoot(), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(serviceLogPath()), { recursive: true, mode: 0o700 });
    const serviceId = `bridge:${randomUUID()}`;
    const logFd = openSync(serviceLogPath(), "a", 0o600);
    let child;
    try {
      child = await new Promise((resolveSpawn, rejectSpawn) => {
        const candidate = spawn("bash", ["bin/start.sh"], {
          cwd: resolvedBridgeDir,
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: { ...env, AMUX_BRIDGE_SUPERVISOR_ID: serviceId },
        });
        candidate.once("error", rejectSpawn);
        candidate.once("spawn", () => resolveSpawn(candidate));
      });
      child.unref();
    } finally {
      closeSync(logFd);
    }
    const record = {
      pid: child.pid,
      serviceId,
      bridgeDir: resolvedBridgeDir,
      logPath: serviceLogPath(),
      startedAt: new Date().toISOString(),
    };
    writeServiceRecord(record);
    writeMode(BRIDGE_MODE_MANAGED);
    if (await waitUntilReady(30_000)) {
      console.log(`Bridge started (managed supervisor pid ${record.pid}; no tmux).`);
      return;
    }

    await stopManagedSupervisor({ force: true }).catch(() => {});
    clearRuntimeState();
    writeMode(BRIDGE_MODE_STOPPED);
    const tail = tailManagedLog();
    console.error(`Bridge did not become ready. Last managed output:\n${tail || "(no output captured)"}\n\nRetry with 'amux stop && amux serve --detach'.`);
    process.exitCode = 1;
  }

  /** WHAT: Starts the bridge in the requested ownership mode. WHY: Keeps manual ownership default and managed mode explicit. */
  async function serve(flags, ctx) {
    let mode;
    try { mode = resolveServeMode(flags); }
    catch (error) { console.error(error.message); process.exitCode = 1; return; }

    const hadLegacySession = await hasSession(ctx, LEGACY_BRIDGE_SESSION);
    if (isReady()) {
      const location = managedSupervisorAlive()
        ? "managed background supervisor"
        : hadLegacySession ? "legacy managed tmux session" : "another terminal";
      console.log(`Bridge already running in ${location}. Run 'amux stop' before switching mode.`);
      return;
    }
    if (isAlive()) {
      console.log("Bridge process is running; waiting for readiness...");
      if (await waitUntilReady(30_000)) {
        console.log("Bridge started.");
        return;
      }
      console.error("Bridge process is alive but unready. Run 'amux stop', then start it again.");
      process.exitCode = 1;
      return;
    }
    if (managedSupervisorAlive()) {
      console.log("Stale or unready managed supervisor detected. Cleaning up...");
      await stopManagedSupervisor({ force: true });
    } else {
      clearServiceRecord(readServiceRecord());
    }
    if (hadLegacySession) {
      console.log("Legacy managed tmux session detected. Cleaning it up before tmux-free launch...");
      await killSession(ctx, LEGACY_BRIDGE_SESSION);
    }
    return mode === BRIDGE_MODE_MANUAL ? startForeground(ctx) : startManaged(ctx);
  }

  /** WHAT: Stops any bridge and records intentional shutdown. WHY: Prevents watchdog from reversing Ctrl+C or amux stop. */
  async function stop(ctx) {
    writeMode(BRIDGE_MODE_STOPPED);
    const hadLegacySession = await hasSession(ctx, LEGACY_BRIDGE_SESSION);
    const wasAlive = isAlive();
    const managedBefore = managedSupervisorAlive();
    signalBridge();
    const record = readServiceRecord();
    if (record && serviceRecordMatches(record)) {
      await waitUntilStopped(record.pid, 5_000);
      if (serviceRecordMatches(readServiceRecord())) await stopManagedSupervisor({ force: true });
      else clearServiceRecord(record);
    } else if (record && !processAlive(record.pid)) {
      clearServiceRecord(record);
    }
    if (hadLegacySession) await killSession(ctx, LEGACY_BRIDGE_SESSION);
    clearRuntimeState();
    if (!hadLegacySession && !wasAlive && !managedBefore) {
      console.log("Bridge is not running.");
      return false;
    }
    console.log("Bridge stopped.");
    return true;
  }

  return { isAlive, isReady, serve, stop };
}
