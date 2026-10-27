// On-demand CPU profile of a running process, without a restart or a debug port.
// The bridge's main thread was saturated on 27 Oct and could not be profiled:
// SIGUSR1 starts `amux sync` there, and ptrace is closed on this host.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SECONDS = 30;
const MAX_SECONDS = 120;

/**
 * WHAT: Records a CPU profile when `<dir>/<pid>.request` appears; the file may hold the seconds.
 * WHY: Names the function that holds a busy event loop instead of guessing from I/O samples.
 */
export function watchCpuProfileRequests({ dir = join(homedir(), ".agentmux", "profiles"), pid = process.pid,
  intervalMs = 5_000, log = (line) => console.log(`cpu-profile | ${line}`) } = {}) {
  const request = join(dir, `${pid}.request`);
  let recording = false;
  const timer = setInterval(() => {
    if (recording || !existsSync(request)) return;
    recording = true;
    const seconds = requestedSeconds(readFileSync(request, "utf8"), log);
    rmSync(request, { force: true });
    record(seconds, join(dir, `${pid}-${new Date().toISOString().replace(/[:.]/gu, "-")}.cpuprofile`), log)
      .finally(() => { recording = false; });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

function requestedSeconds(text, log) {
  if (!text.trim()) return DEFAULT_SECONDS;
  const seconds = Number(text.trim());
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds, MAX_SECONDS);
  log(`request "${text.trim().slice(0, 20)}" is not a number of seconds; recording ${DEFAULT_SECONDS} s`);
  return DEFAULT_SECONDS;
}

function record(seconds, path, log) {
  const session = new Session();
  session.connect();
  const post = (method, params) => new Promise((resolve, reject) =>
    session.post(method, params, (error, result) => (error ? reject(error) : resolve(result))));
  log(`recording ${seconds} s`);
  return post("Profiler.enable")
    .then(() => post("Profiler.start"))
    .then(() => new Promise((resolve) => setTimeout(resolve, seconds * 1000)))
    .then(() => post("Profiler.stop"))
    .then(({ profile }) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(profile));
      log(`wrote ${path}`);
    })
    .catch((error) => log(`failed: ${error.message}`))
    .finally(() => session.disconnect());
}
