import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const safeName = (value) => String(value).replace(/[^a-zA-Z0-9_-]+/gu, "-").slice(0, 80);
const commandHash = (value) => createHash("sha256").update(String(value)).digest("hex");

export function nativeServicePaths(agentName, index, stateDir = null) {
  const root = resolve(stateDir || join(homedir(), ".agentmux", "native-services"));
  const key = `${safeName(agentName)}-${Number(index)}`;
  return {
    root,
    recordPath: join(root, `${key}.json`),
    logPath: join(root, `${key}.log`),
  };
}

const readRecord = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

const processAlive = (pid, kill = process.kill.bind(process)) => {
  if (!Number.isSafeInteger(Number(pid)) || Number(pid) <= 0) return false;
  try { kill(Number(pid), 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
};

export function nativeServiceProcessMatches(record, {
  readFile = readFileSync,
  readlink = readlinkSync,
  kill = process.kill.bind(process),
} = {}) {
  if (!record?.serviceId || !processAlive(record.pid, kill)) return false;
  try {
    const environment = readFile(`/proc/${Number(record.pid)}/environ`, "utf8").split("\0");
    const cwd = readlink(`/proc/${Number(record.pid)}/cwd`);
    return environment.includes(`AMUX_NATIVE_SERVICE_ID=${record.serviceId}`)
      && resolve(cwd) === resolve(record.cwd);
  } catch {
    return false;
  }
}

const atomicRecord = (path, record) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

export function nativeServiceStatus({ agentName, index, command, cwd, stateDir } = {}) {
  const paths = nativeServicePaths(agentName, index, stateDir);
  const record = readRecord(paths.recordPath);
  const managed = nativeServiceProcessMatches(record);
  const matchesConfig = managed && record.commandHash === commandHash(command)
    && resolve(record.cwd) === resolve(cwd);
  return {
    agentName,
    index: Number(index),
    command,
    cwd: resolve(cwd),
    paths,
    record,
    managed,
    matchesConfig,
    staleRecord: Boolean(record && !managed),
  };
}

export async function startNativeService({
  agentName,
  index,
  command,
  cwd,
  stateDir,
  spawnImpl = spawn,
  startupMs = 300,
  sleepImpl = sleep,
} = {}) {
  if (!agentName || !Number.isSafeInteger(Number(index)) || Number(index) < 0) {
    throw new Error("native service requires agentName and a non-negative index");
  }
  if (!String(command || "").trim()) throw new Error("native service command is empty");
  if (!existsSync(cwd)) throw new Error(`native service cwd does not exist: ${cwd}`);
  const before = nativeServiceStatus({ agentName, index, command, cwd, stateDir });
  if (before.matchesConfig) return { ...before, alreadyRunning: true };
  if (before.managed) {
    throw new Error(`${agentName} service ${index} is managed with different config; stop it first`);
  }
  mkdirSync(before.paths.root, { recursive: true, mode: 0o700 });
  try { unlinkSync(before.paths.recordPath); } catch {}
  const serviceId = `${safeName(agentName)}:${Number(index)}:${commandHash(command).slice(0, 16)}`;
  const logFd = openSync(before.paths.logPath, "a", 0o600);
  let child;
  try {
    child = await new Promise((resolveSpawn, rejectSpawn) => {
      const candidate = spawnImpl("/bin/bash", ["-lc", `exec ${command}`], {
        cwd: resolve(cwd),
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, AMUX_NATIVE_SERVICE_ID: serviceId },
      });
      candidate.once("error", rejectSpawn);
      candidate.once("spawn", () => resolveSpawn(candidate));
    });
    child.unref?.();
  } finally {
    closeSync(logFd);
  }
  const record = {
    pid: child.pid,
    serviceId,
    agentName,
    index: Number(index),
    command: String(command),
    commandHash: commandHash(command),
    cwd: resolve(cwd),
    logPath: before.paths.logPath,
    startedAt: new Date().toISOString(),
  };
  atomicRecord(before.paths.recordPath, record);
  await sleepImpl(startupMs);
  const after = nativeServiceStatus({ agentName, index, command, cwd, stateDir });
  if (!after.matchesConfig) {
    throw new Error(`${agentName} service ${index} exited during startup; inspect ${after.paths.logPath}`);
  }
  return { ...after, started: true };
}

export async function stopNativeService({
  agentName,
  index,
  command,
  cwd,
  stateDir,
  force = false,
  timeoutMs = 5_000,
  sleepImpl = sleep,
  kill = process.kill.bind(process),
} = {}) {
  const before = nativeServiceStatus({ agentName, index, command, cwd, stateDir });
  if (!before.managed) {
    if (before.staleRecord) { try { unlinkSync(before.paths.recordPath); } catch {} }
    return { ...before, alreadyStopped: true };
  }
  if (!before.matchesConfig) throw new Error(`${agentName} service ${index} ownership does not match config`);
  const assertOwned = () => {
    const record = readRecord(before.paths.recordPath);
    if (Number(record?.pid) !== Number(before.record.pid) || !nativeServiceProcessMatches(record, { kill })) {
      throw new Error(`${agentName} service ${index} ownership changed; refusing to signal`);
    }
    return record;
  };
  assertOwned();
  kill(-Number(before.record.pid), "SIGTERM");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && processAlive(before.record.pid, kill)) await sleepImpl(100);
  if (processAlive(before.record.pid, kill)) {
    if (!force) throw new Error(`${agentName} service ${index} did not stop cleanly`);
    assertOwned();
    kill(-Number(before.record.pid), "SIGKILL");
  }
  const current = readRecord(before.paths.recordPath);
  if (current?.serviceId === before.record.serviceId && Number(current.pid) === Number(before.record.pid)) {
    try { unlinkSync(before.paths.recordPath); } catch {}
  }
  return { ...before, stopped: true, managed: false };
}

export async function startNativeServices(target, options = {}) {
  const started = [];
  try {
    for (let index = 0; index < target.services.length; index += 1) {
      const result = await startNativeService({
        agentName: target.name,
        index,
        command: target.services[index],
        cwd: target.dir,
        ...options,
      });
      started.push(result);
    }
    return started;
  } catch (error) {
    for (const result of [...started].reverse()) {
      await stopNativeService({
        agentName: result.agentName,
        index: result.index,
        command: result.command,
        cwd: result.cwd,
        ...options,
        force: true,
      }).catch(() => {});
    }
    throw error;
  }
}

export async function stopNativeServices(target, options = {}) {
  const stopped = [];
  for (let index = target.services.length - 1; index >= 0; index -= 1) {
    stopped.push(await stopNativeService({
      agentName: target.name,
      index,
      command: target.services[index],
      cwd: target.dir,
      ...options,
    }));
  }
  return stopped;
}
