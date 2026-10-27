// Periodic checkpoint trim of provider journals. It runs as its own `amux trim` process,
// so the bridge never copies hundreds of MB on its main thread, and it counts from the
// last run on disk, so frequent bridge restarts cannot postpone it. Before 27 Oct the
// trim ran only when `amux serve` started (at most 8 files).
import { spawn } from "node:child_process";
import { closeSync, openSync, statSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const EVERY_MS = 6 * 60 * 60_000;
const CHECK_MS = 15 * 60_000;
const MAX_FILES = 8;
const CLI = fileURLToPath(new URL("../bin/agent-cli.mjs", import.meta.url));

/**
 * WHAT: Builds a timer that starts `amux trim` once its last run is six hours old.
 * WHY: Keeps journals from growing between serve restarts without blocking delivery.
 */
export function scheduleSessionTrim({ marker = join(homedir(), ".agentmux", "session-trim.last"), everyMs = EVERY_MS,
  checkMs = CHECK_MS, now = Date.now, start = spawn, log = (line) => console.log(`session-trim | ${line}`) } = {}) {
  let running = false;
  const due = () => { try { return now() - statSync(marker).mtimeMs >= everyMs; } catch { return true; } };
  const tick = () => {
    if (running || !due()) return false;
    running = true;
    closeSync(openSync(marker, "a"));
    utimesSync(marker, now() / 1000, now() / 1000);
    const child = start(process.execPath, [CLI, "trim", "--max-files", String(MAX_FILES)], { stdio: ["ignore", "pipe", "ignore"] });
    let summary = "";
    child.stdout?.on("data", (chunk) => { if (summary.length < 500) summary += chunk; });
    child.on("error", (error) => { running = false; log(`could not start amux trim: ${error.message}`); });
    child.on("exit", (code) => { running = false; log(`amux trim exited ${code}: ${summary.split("\n")[0]}`); });
    return true;
  };
  const timer = setInterval(tick, checkMs);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
