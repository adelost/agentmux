// Bridge process lifecycle for the CLI. Foreground is the normal path;
// detached tmux ownership is an explicit opt-in.

import { readFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { esc } from "../lib.mjs";
import { hasSession, killSession } from "./tmux.mjs";
import {
  BRIDGE_MODE_MANAGED,
  BRIDGE_MODE_MANUAL,
  BRIDGE_MODE_STOPPED,
  resolveServeMode,
  writeBridgeMode,
} from "../core/bridge-mode.mjs";

const BRIDGE_SESSION = "amux";

/**
 * WHAT: Routes foreground, detached, readiness, and stop behavior for the Discord bridge.
 * WHY: Keeps bridge process policy out of the general command dispatcher.
 */
export function createBridgeLifecycle({ bridgeDir, env = process.env } = {}) {
  const pidfile = () => env.PIDFILE || "/tmp/agentmux.pid";
  const readyFile = () => env.READY_FILE || "/tmp/agentmux.ready";

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

  /** WHAT: Reports whether the bridge process exists. WHY: Separates process truth from optional tmux ownership. */
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    return false;
  }

  /** WHAT: Clears stale pid and readiness markers. WHY: Keeps WSL pid reuse from blocking a fresh launch. */
  function clearRuntimeState() {
    try { unlinkSync(pidfile()); } catch {}
    try { unlinkSync(readyFile()); } catch {}
  }

  /** WHAT: Stops the process named by the pidfile. WHY: Keeps foreground and detached shutdown on one path. */
  function killByPid() {
    try {
      const livePid = parseInt(readFileSync(pidfile(), "utf-8").trim());
      if (livePid) {
        try { process.kill(livePid, "SIGTERM"); } catch {}
      }
    } catch {}
    clearRuntimeState();
  }

  /** WHAT: Runs the bridge under the visible terminal. WHY: Makes logs and Ctrl+C the default ownership experience. */
  async function startForeground(ctx) {
    clearRuntimeState();
    writeBridgeMode(BRIDGE_MODE_MANUAL);
    console.log("Bridge running in this terminal. Ctrl+C stops it; use 'amux doctor' from another terminal to inspect it.\n");
    const child = spawn("bash", ["bin/start.sh"], { cwd: ctx.bridgeDir || bridgeDir, stdio: "inherit" });
    return new Promise((resolveChild, rejectChild) => {
      child.once("error", rejectChild);
      child.once("exit", (code) => {
        if (code && code !== 130) process.exitCode = code;
        resolveChild();
      });
    });
  }

  /** WHAT: Starts the bridge in its managed tmux session. WHY: Isolates legacy restore-race handling to explicit detach mode. */
  async function startManaged(ctx) {
    writeBridgeMode(BRIDGE_MODE_MANAGED);
    const startSession = async () => {
      clearRuntimeState();
      await ctx.tmux(`new-session -d -s '${esc(BRIDGE_SESSION)}' -c '${esc(bridgeDir)}' 'bash bin/start.sh'`);
    };

    try {
      await startSession();
    } catch (err) {
      console.log(`new-session failed (${String(err?.message || err).split("\n")[0]}) — retrying once on a warm server...`);
      await killSession(ctx, BRIDGE_SESSION).catch(() => {});
      await startSession();
    }
    if (await waitUntilReady(20_000)) {
      console.log(`Bridge started (managed session: ${BRIDGE_SESSION}).`);
      return;
    }

    console.log("Bridge not ready — recreating once after tmux restore...");
    await killSession(ctx, BRIDGE_SESSION).catch(() => {});
    await startSession();
    if (await waitUntilReady(30_000)) {
      console.log(`Bridge started (managed session: ${BRIDGE_SESSION}).`);
      return;
    }

    let tail = "";
    try {
      const captured = await ctx.tmux(`capture-pane -t '${esc(BRIDGE_SESSION)}' -p -S -50`);
      tail = (captured?.stdout ?? "").trim();
    } catch (err) {
      tail = `(capture failed: ${err?.message || err})`;
    }
    console.error(`Bridge did not become ready. Last managed output:\n${tail || "(no output captured)"}\n\nRetry with 'amux stop && amux serve --detach'.`);
    process.exitCode = 1;
  }

  /** WHAT: Starts the bridge in the requested ownership mode. WHY: Keeps manual ownership default and managed mode explicit. */
  async function serve(flags, ctx) {
    let mode;
    try { mode = resolveServeMode(flags); }
    catch (err) { console.error(err.message); process.exitCode = 1; return; }

    const hadSession = await hasSession(ctx, BRIDGE_SESSION);
    if (isReady()) {
      const location = hadSession ? "managed tmux session" : "another terminal";
      console.log(`Bridge already running in ${location}. Run 'amux stop' before switching mode.`);
      return;
    }
    if (isAlive()) {
      console.log("Bridge process is running; waiting for readiness...");
      if (await waitUntilReady(30_000)) {
        console.log("Bridge started.");
        return;
      }
      if (!hadSession) {
        console.error("Bridge process is alive but unready. Run 'amux stop', then start it again.");
        process.exitCode = 1;
        return;
      }
    }
    if (hadSession) {
      console.log("Stale or unready managed session detected. Cleaning up...");
      await killSession(ctx, BRIDGE_SESSION);
    }
    return mode === BRIDGE_MODE_MANUAL ? startForeground(ctx) : startManaged(ctx);
  }

  /** WHAT: Stops any bridge and records intentional shutdown. WHY: Prevents watchdog from reversing Ctrl+C or amux stop. */
  async function stop(ctx) {
    writeBridgeMode(BRIDGE_MODE_STOPPED);
    const hadSession = await hasSession(ctx, BRIDGE_SESSION);
    const wasAlive = isAlive();
    killByPid();
    if (hadSession) await killSession(ctx, BRIDGE_SESSION);
    if (!hadSession && !wasAlive) {
      console.log("Bridge is not running.");
      return false;
    }
    console.log("Bridge stopped.");
    return true;
  }

  return { isAlive, isReady, serve, stop };
}
