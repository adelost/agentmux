// Background notification worker. Polls tmux until agent finishes, then notifies.
// Replaces agent-notify-worker.sh. Runs as detached child process.

import { createEventLogger } from "./events.mjs";
import { detectPaneStatus } from "./format.mjs";
import { sendToChannel, sendToSession } from "./send-notify.mjs";
import { stripAnsi } from "../lib.mjs";

const PROGRESS_MILESTONES = [60, 300, 600]; // seconds

/**
 * Poll agent until done, then notify via Discord/session.
 * Designed to run as a detached background process.
 */
export async function notifyWorker({ name, pane, timeout, notifyChannel, msgSession, prompt, agent }) {
  const notify = buildNotifier(notifyChannel, msgSession);
  const log = createEventLogger({ notify });
  const startTime = Date.now();
  const deadline = startTime + timeout * 1000;
  const interval = 2000;

  let sawWorking = false;
  let lastBuffer = "";
  let staleCount = 0;
  let nextMilestone = 0;

  // Grace period: wait up to 60s for agent to start working
  const graceDeadline = Date.now() + 60000;
  while (Date.now() < graceDeadline) {
    const status = await safeGetStatus(agent, name, pane);
    if (status === "working") { sawWorking = true; break; }
    if (status === "idle" && sawWorking) break;
    await sleep(interval);
  }

  // Main poll loop
  while (Date.now() < deadline) {
    const status = await safeGetStatus(agent, name, pane);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Progress milestones
    if (nextMilestone < PROGRESS_MILESTONES.length && elapsed >= PROGRESS_MILESTONES[nextMilestone]) {
      log("⏳", name, pane, "PROGRESS", `${formatElapsed(elapsed)} elapsed`);
      nextMilestone++;
    }

    // Stuck detection: same buffer for 120s
    try {
      const raw = await agent.capturePane(name, pane, 30);
      const buffer = stripAnsi(raw);
      if (buffer === lastBuffer) {
        staleCount += interval / 1000;
        if (staleCount >= 120) {
          log("⚠️", name, pane, "STUCK", `Same output for ${staleCount}s`);
          staleCount = 0; // reset, warn again later
        }
      } else {
        staleCount = 0;
        lastBuffer = buffer;
      }
    } catch {}

    if (status === "working") {
      sawWorking = true;
    } else if (status === "menu") {
      log("📋", name, pane, "MENU", "Waiting for menu selection");
      return;
    } else if (status === "permission") {
      log("🔐", name, pane, "PERMISSION", "Waiting for permission");
      return;
    } else if (status === "idle" && sawWorking) {
      // Done! Collect response
      const text = await safeGetResponse(agent, name, pane);
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      log("✅", name, pane, "DONE", `Finished in ${formatElapsed(elapsed)}`, text);
      return;
    }

    await sleep(interval);
  }

  // Timeout - but keep polling every 30s in case it finishes
  log("⏰", name, pane, "TIMEOUT", `Timeout after ${timeout}s, still monitoring`);
  while (true) {
    await sleep(30000);
    const status = await safeGetStatus(agent, name, pane);
    if (status === "idle") {
      const text = await safeGetResponse(agent, name, pane);
      log("✅", name, pane, "DONE", "Finished (post-timeout)", text);
      return;
    }
  }
}

/**
 * Spawn notify worker as detached background process.
 * Returns immediately, worker runs independently.
 */
export function spawnNotifyWorker(opts) {
  const { fork } = require("child_process");
  const worker = fork(new URL("./notify-worker-entry.mjs", import.meta.url).pathname, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, NOTIFY_OPTS: JSON.stringify(opts) },
  });
  worker.unref();
  return worker.pid;
}

// --- Helpers ---

function buildNotifier(channel, session) {
  return async (message) => {
    const promises = [];
    if (channel) promises.push(sendToChannel(channel, message).catch(() => {}));
    if (session) promises.push(sendToSession(session, message).catch(() => {}));
    await Promise.all(promises);
  };
}

async function safeGetStatus(agent, name, pane) {
  try {
    const raw = await agent.capturePane(name, pane, 30);
    return detectPaneStatus(stripAnsi(raw));
  } catch {
    return "unknown";
  }
}

async function safeGetResponse(agent, name, pane) {
  try { return await agent.getResponse(name, pane); } catch { return ""; }
}

function formatElapsed(secs) {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
