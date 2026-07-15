import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function locations({ port, stateDir, dataDir }) {
  const root = resolve(stateDir || join(homedir(), ".agentmux", `web-runtime-${port}`));
  return {
    root,
    pidPath: join(root, "process.json"),
    logPath: join(root, "runtime.log"),
    dataDir: resolve(dataDir || join(homedir(), ".agentmux", "web-ui")),
  };
}

function readPid(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function processAlive(pid) {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function processMatches(record) {
  if (!record?.serverPath || !processAlive(record.pid)) return false;
  try {
    const args = readFileSync(`/proc/${Number(record.pid)}/cmdline`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((value) => resolve(value));
    const environment = readFileSync(`/proc/${Number(record.pid)}/environ`, "utf8")
      .split("\0");
    return args.includes(resolve(record.serverPath))
      && environment.includes(`AMUX_WEB_PORT=${Number(record.port)}`);
  } catch {
    // Refuse ownership when process identity cannot be proven. A stale PID
    // must never let `amux runtime stop` signal an unrelated reused process.
    return false;
  }
}

async function health(url, fetchImpl, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${url}/api/health`, { signal: controller.signal });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function nativeRuntimeEnvironment({
  port,
  dataDir,
  legacyDataDir,
  eventsPath,
  baseEnv = process.env,
} = {}) {
  return {
    ...baseEnv,
    AMUX_WEB_PORT: String(port),
    AMUX_WEB_DATA_DIR: resolve(dataDir),
    ...(eventsPath ? { AMUX_EVENTS_PATH: resolve(eventsPath) } : {}),
    ...(legacyDataDir === null
      ? { AMUX_WEB_LEGACY_DATA_DIR: "off" }
      : legacyDataDir ? { AMUX_WEB_LEGACY_DATA_DIR: resolve(legacyDataDir) } : {}),
  };
}

export async function nativeRuntimeStatus({
  port = 8811,
  host = "127.0.0.1",
  stateDir,
  dataDir,
  fetchImpl = globalThis.fetch,
} = {}) {
  const paths = locations({ port, stateDir, dataDir });
  const processRecord = readPid(paths.pidPath);
  const alive = processMatches(processRecord);
  const url = `http://${host}:${port}`;
  const runtimeHealth = await health(url, fetchImpl);
  return {
    url,
    paths,
    managed: alive,
    pid: alive ? Number(processRecord.pid) : null,
    online: Boolean(runtimeHealth?.ok),
    health: runtimeHealth,
    stalePid: Boolean(processRecord && !alive),
  };
}

export async function startNativeRuntime({
  serverPath,
  port = 8811,
  host = "127.0.0.1",
  stateDir,
  dataDir,
  legacyDataDir,
  eventsPath,
  fetchImpl = globalThis.fetch,
  spawnImpl = spawn,
  startupTimeoutMs = 10_000,
} = {}) {
  if (!serverPath || !existsSync(serverPath)) throw new Error("native runtime server path is missing");
  const before = await nativeRuntimeStatus({ port, host, stateDir, dataDir, fetchImpl });
  if (before.online) return { ...before, alreadyRunning: true };
  if (before.managed) {
    throw new Error(`native runtime pid ${before.pid} is alive but health is unavailable; inspect ${before.paths.logPath}`);
  }

  mkdirSync(before.paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(before.paths.dataDir, { recursive: true, mode: 0o700 });
  const logFd = openSync(before.paths.logPath, "a", 0o600);
  let child;
  try {
    child = spawnImpl(process.execPath, [resolve(serverPath)], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: nativeRuntimeEnvironment({
        port,
        dataDir: before.paths.dataDir,
        legacyDataDir,
        eventsPath,
      }),
    });
    child.unref?.();
  } finally {
    closeSync(logFd);
  }
  const record = {
    pid: child.pid,
    port,
    serverPath: resolve(serverPath),
    dataDir: before.paths.dataDir,
    legacyDataDir: legacyDataDir === null ? null : legacyDataDir ? resolve(legacyDataDir) : undefined,
    eventsPath: eventsPath ? resolve(eventsPath) : undefined,
    startedAt: new Date().toISOString(),
  };
  const temporary = `${before.paths.pidPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, before.paths.pidPath);

  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    const current = await nativeRuntimeStatus({ port, host, stateDir, dataDir, fetchImpl });
    if (current.online) return { ...current, started: true };
    if (!processAlive(child.pid)) break;
    await sleep(100);
  }
  try { process.kill(child.pid, "SIGTERM"); } catch {}
  throw new Error(`native runtime failed to become healthy; inspect ${before.paths.logPath}`);
}

export async function stopNativeRuntime({
  port = 8811,
  host = "127.0.0.1",
  stateDir,
  dataDir,
  fetchImpl = globalThis.fetch,
  force = false,
  timeoutMs = 5_000,
  statusImpl = nativeRuntimeStatus,
  readPidImpl = readPid,
  processMatchesImpl = processMatches,
  processAliveImpl = processAlive,
  killImpl = process.kill.bind(process),
  sleepImpl = sleep,
} = {}) {
  const before = await statusImpl({ port, host, stateDir, dataDir, fetchImpl });
  if (!before.managed) {
    if (before.online) throw new Error("native runtime is online but not owned by this service manager");
    return { ...before, stopped: false, alreadyStopped: true };
  }
  if (!force && Number(before.health?.running || 0) > 0) {
    throw new Error(`native runtime has ${before.health.running} active turn(s); retry when idle or pass --force`);
  }

  // nativeRuntimeStatus proved ownership before its health request. The
  // process can exit and its PID can be reused during that await, so the
  // proof must be repeated immediately before every destructive signal.
  // Re-reading process.json also prevents a concurrently restarted runtime
  // from inheriting the old stop operation.
  const ownedRecord = (signal) => {
    const record = readPidImpl(before.paths.pidPath);
    if (Number(record?.pid) !== Number(before.pid) || !processMatchesImpl(record)) {
      throw new Error(`native runtime ownership changed before ${signal}; refusing to signal pid ${before.pid}`);
    }
    return record;
  };

  const initialRecord = ownedRecord("SIGTERM");
  killImpl(before.pid, "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAliveImpl(before.pid)) await sleepImpl(100);
  if (processAliveImpl(before.pid)) {
    if (!force) throw new Error(`native runtime pid ${before.pid} did not stop cleanly`);
    ownedRecord("SIGKILL");
    killImpl(before.pid, "SIGKILL");
  }

  // Do not unlink a newer manager record installed by a concurrent restart.
  const currentRecord = readPidImpl(before.paths.pidPath);
  const sameRecord = Number(currentRecord?.pid) === Number(initialRecord.pid)
    && currentRecord?.serverPath === initialRecord.serverPath
    && Number(currentRecord?.port) === Number(initialRecord.port)
    && currentRecord?.startedAt === initialRecord.startedAt;
  if (sameRecord) {
    try { unlinkSync(before.paths.pidPath); } catch {}
  }
  return { ...before, online: false, managed: false, stopped: true };
}
