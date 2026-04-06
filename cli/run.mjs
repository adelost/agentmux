// Oneshot worker: run a single claude task via pipe mode (claude -p).
// Replaces agent-run-worker-pipe.sh. Spawns claude as child process.

import { spawn } from "child_process";
import { createReadStream } from "fs";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { createEventLogger } from "./events.mjs";
import { sendToChannel, sendToSession } from "./send-notify.mjs";

const RUNS_DIR = "/tmp/agent-runs";
const CLAUDE_FLAGS = ["--dangerously-skip-permissions", "--no-session-persistence", "--verbose"];

/**
 * Run a single claude task via pipe mode.
 * @param {{ dir, prompt, timeout, notifyChannel, msgSession, model, fg }} opts
 */
export async function runOneshot({ dir, prompt, timeout = 600, notifyChannel, msgSession, model, fg = false }) {
  const notify = buildNotifier(notifyChannel, msgSession);
  const log = createEventLogger({ notify });
  const sessionId = `run_${process.pid}_${Date.now()}`;
  const startTime = Date.now();

  // Write metadata for agent ps
  mkdirSync(RUNS_DIR, { recursive: true });
  const metaFile = join(RUNS_DIR, `${sessionId}.json`);
  writeFileSync(metaFile, JSON.stringify({ pid: process.pid, session: sessionId, dir, prompt, started: Math.floor(startTime / 1000) }));

  const args = ["-p", "--output-format", "stream-json", ...CLAUDE_FLAGS];
  if (model) args.push("--model", model);

  const child = spawn("claude", args, {
    cwd: dir,
    timeout: timeout * 1000,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  let finalText = "";
  let toolCount = 0;
  let filesChanged = 0;
  let buffer = "";

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text") finalText += block.text + "\n";
            if (block.type === "tool_use") toolCount++;
          }
        }
        if (event.type === "result") {
          finalText = event.result || finalText;
        }
      } catch {}
    }
  });

  // Send prompt via stdin
  child.stdin.write(prompt);
  child.stdin.end();

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(1));
  });

  const elapsed = Math.floor((Date.now() - startTime) / 1000);

  // Save result
  const resultFile = `/tmp/agent-result-${sessionId}.txt`;
  writeFileSync(resultFile, finalText);

  // Cleanup metadata
  try { unlinkSync(metaFile); } catch {}

  // Notify
  const icon = exitCode === 0 ? "✅" : "❌";
  const event = exitCode === 0 ? "DONE" : "ERROR";
  const detail = `${formatElapsed(elapsed)}, ${toolCount} tools, exit ${exitCode}`;
  log(icon, "run", 0, event, detail, finalText.slice(0, 500));

  if (fg) {
    console.log(finalText);
    console.log(`\n${icon} ${detail}`);
  }

  return { exitCode, text: finalText, elapsed, toolCount, resultFile };
}

/** Show latest oneshot result/log. */
export function showRunLog(lines = 50, follow = false) {
  const { readdirSync } = require("fs");

  // Try result file first
  try {
    const results = readdirSync("/tmp").filter((f) => f.startsWith("agent-result-")).sort().reverse();
    if (results.length) {
      const path = join("/tmp", results[0]);
      const content = readFileSync(path, "utf-8");
      const tail = content.split("\n").slice(-lines).join("\n");
      console.log(`📄 ${path}`);
      console.log("---");
      console.log(tail);
      return;
    }
  } catch {}

  // Try bg log
  try {
    const logs = readdirSync("/tmp").filter((f) => f.startsWith("agent-run-bg-")).sort().reverse();
    if (logs.length) {
      const path = join("/tmp", logs[0]);
      const content = readFileSync(path, "utf-8");
      console.log(`📄 ${path}`);
      console.log("---");
      console.log(content.split("\n").slice(-lines).join("\n"));
      return;
    }
  } catch {}

  console.error("No oneshot logs found.");
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

function formatElapsed(secs) {
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
