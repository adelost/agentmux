import {
  mkdirSync, readFileSync, rmSync, writeFileSync,
} from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { spawn } from "child_process";

// WHAT: Defines the foreground poll cadence. WHY: Keeps server load bounded by one visible minute loop.
export const SUGGESTIONS_POLL_INTERVAL_MS = 60_000;
// WHAT: Names every Suggestions input component. WHY: Keeps foreground ownership complete and data-driven.
export const SUGGESTIONS_COMPONENTS = Object.freeze([
  Object.freeze({
    name: "comments",
    wrapper: "suggestions-comment-bridge-cron.sh",
    installer: "install-suggestions-comment-bridge.sh",
  }),
  Object.freeze({
    name: "outbox",
    wrapper: "suggestions-watchdog-outbox-cron.sh",
    installer: "install-suggestions-watchdog-outbox.sh",
  }),
]);

const processAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
};

/** WHAT: Stores one visible Suggestions poller owner. WHY: Keeps two foreground terminals from alternating ownership. */
export function claimSuggestionsPoller({
  root = join(homedir(), ".agentmux", "suggestions-poller.lock"),
  pid = process.pid,
  now = () => Date.now(),
  isAlive = processAlive,
} = {}) {
  const claim = () => {
    mkdirSync(root, { mode: 0o700 });
    writeFileSync(join(root, "owner.json"), `${JSON.stringify({
      schemaVersion: 1, pid, startedAt: now(),
    })}\n`, { mode: 0o600 });
  };
  try {
    claim();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const owner = readJson(join(root, "owner.json"));
    if (isAlive(Number(owner?.pid))) {
      throw new Error(`Suggestions poller already runs as pid ${owner.pid}`);
    }
    rmSync(root, { recursive: true, force: true });
    claim();
  }
  return () => {
    const owner = readJson(join(root, "owner.json"));
    if (Number(owner?.pid) === pid) rmSync(root, { recursive: true, force: true });
  };
}

const childResult = (command, args, options) => new Promise((resolveResult, reject) => {
  const child = spawn(command, args, options);
  child.once("error", reject);
  child.once("exit", (code, signal) => resolveResult({
    code: Number.isInteger(code) ? code : 1,
    signal: signal || null,
  }));
});

const waitForNextCycle = (ms, signal) => new Promise((resolveWait) => {
  if (signal?.aborted || ms <= 0) return resolveWait();
  const done = () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", done);
    resolveWait();
  };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

/** WHAT: Filters legacy hidden schedulers out of crontab. WHY: Makes Ctrl+C stop all Suggestions polling. */
export async function removeLegacySuggestionsCrons({
  bridgeDir,
  runChild = childResult,
} = {}) {
  for (const component of SUGGESTIONS_COMPONENTS) {
    const result = await runChild("bash", [
      resolve(bridgeDir, "bin", component.installer), "uninstall",
    ], { stdio: "inherit", env: process.env });
    if (result.code !== 0) {
      throw new Error(`could not remove legacy ${component.name} cron (exit ${result.code})`);
    }
  }
}

/** WHAT: Schedules every Suggestions input in one visible process. WHY: Keeps polling inside one Ctrl+C ownership boundary. */
export async function runSuggestionsForeground({
  bridgeDir,
  once = false,
  intervalMs = SUGGESTIONS_POLL_INTERVAL_MS,
  signal = null,
  now = () => Date.now(),
  wait = waitForNextCycle,
  runChild = childResult,
  removeLegacyCrons = removeLegacySuggestionsCrons,
  claim = claimSuggestionsPoller,
  logger = console,
} = {}) {
  if (!bridgeDir) throw new Error("Suggestions poller requires the agentmux release path");
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60 * 60_000) {
    throw new Error("Suggestions poll interval must be 1000-3600000ms");
  }
  const release = claim();
  try {
    if (!once) await removeLegacyCrons({ bridgeDir, runChild });
    logger.log(`Suggestions polling ${once ? "once" : `in this terminal every ${intervalMs / 1_000}s`}.`
      + `${once ? "" : " Ctrl+C stops it."}`);
    do {
      const startedAt = now();
      const results = await Promise.all(SUGGESTIONS_COMPONENTS.map(async (component) => ({
        name: component.name,
        ...await runChild("bash", [resolve(bridgeDir, "bin", component.wrapper)], {
          stdio: "inherit",
          env: { ...process.env, AMUX_FOREGROUND: "1", NODE_BIN: process.execPath },
        }),
      })));
      const summary = results.map((result) =>
        `${result.name}=${result.code === 0 ? "ok" : `retry(exit ${result.code})`}`).join(" ");
      logger.log(`[${new Date(now()).toISOString()}] ${summary}`);
      if (once) return { exitCode: results.every((result) => result.code === 0) ? 0 : 1, results };
      if (signal?.aborted) break;
      await wait(Math.max(0, intervalMs - (now() - startedAt)), signal);
    } while (!signal?.aborted);
    return { exitCode: 0, results: [] };
  } finally {
    release();
  }
}

/** WHAT: Dispatches the foreground CLI lifecycle. WHY: Turns terminal signals into an honest clean stop. */
export async function cmdSuggestions({ bridgeDir, once = false } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const result = await runSuggestionsForeground({
      bridgeDir, once, signal: controller.signal,
    });
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
    return result;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
