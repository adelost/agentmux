// Agent interaction: send prompts, wait for responses, track progress.
// Wraps tmux + agent CLI with dismiss logic for blocking prompts.

import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { esc, stripAnsi, extractActivity, formatDuration } from "./lib.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments } from "./core/extract.mjs";

const CONTEXT_MAX = 200_000;
const MILESTONES = [30, 60, 120, 300, 600];

export function createAgent({ agentBin, tmuxSocket, timeout, delay, run, tmuxExec }) {
  const wait = delay || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // --- Dismiss ---

  async function dismissBlockingPrompt(target) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout } = await tmuxExec(
          `tmux -S '${tmuxSocket}' capture-pane -t '${esc(target)}' -p`,
        );
        const lastLines = stdout.trimEnd().split("\n").slice(-3).join("\n");
        if (!lastLines.includes("0: Dismiss")) return false;
        await tmuxExec(
          `tmux -S '${tmuxSocket}' send-keys -t '${esc(target)}' '0' Enter`,
        );
        await wait(500);
      } catch {}
    }
    return true;
  }

  async function getResponse(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    const text = extractText(raw);
    return text || "(empty response)";
  }

  /**
   * Check if Claude is busy (working or has pending input).
   * ❯          → idle
   * ❯ fix bug  → pending input (busy)
   * anything else → working (busy)
   */
  async function isBusy(agentName, pane) {
    const raw = await capturePane(agentName, pane, 20);
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || "";
    if (!last.startsWith("❯")) return true;       // working
    if (last.replace(/^❯\s*/, "").length > 0) return true; // pending input
    return false;                                   // idle
  }

  async function getResponseSegments(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    const lastTurn = extractLastTurn(raw);
    return extractSegments(classifyLines(lastTurn));
  }

  // --- Send only (inject without waiting) ---

  async function sendOnly(agentName, prompt, pane) {
    const paneFlag = pane > 0 ? ` -p ${pane}` : "";
    await run(
      `'${esc(agentBin)}' '${esc(agentName)}' '${esc(prompt)}' -q${paneFlag}`,
      30000,
    );
  }

  // --- Pipeline ---

  async function sendAndWait(agentName, prompt, pane) {
    const paneFlag = pane > 0 ? ` -p ${pane}` : "";

    // Preflight: ensure Claude is running and ready before sending prompt.
    // agent send does this internally, but we check here too to avoid
    // capturing startup output as the response.
    let wasStarting = false;
    try {
      const { stdout } = await tmuxExec(
        `tmux -S '${tmuxSocket}' display-message -t '${esc(agentName)}:.${pane}' -p '#{pane_current_command}'`,
      );
      if (!stdout.trim().includes("claude")) {
        wasStarting = true;
      }
    } catch {}

    await run(
      `'${esc(agentBin)}' '${esc(agentName)}' '${esc(prompt)}' -q${paneFlag}`,
      30000,
    );

    // Extra wait if Claude was just started (let it load context before we poll)
    await wait(wasStarting ? 8000 : 3000);
    const waitSecs = Math.floor(timeout / 1000);
    await run(
      `'${esc(agentBin)}' wait '${esc(agentName)}' -t ${waitSecs}${paneFlag}`,
      timeout,
    );

    // Cleanup: dismiss any blocking prompt (survey etc.) so next input works
    const target = `${agentName}:.${pane}`;
    await dismissBlockingPrompt(target);

    return getResponse(agentName, pane);
  }

  // --- Activity ---

  async function peekActivity(agentName, pane) {
    try {
      const { stdout } = await tmuxExec(
        `tmux -S '${tmuxSocket}' capture-pane -t '${esc(agentName)}:.${pane}' -p -S -10`,
      );
      return extractActivity(stdout);
    } catch {
      return null;
    }
  }

  function startProgressTimer(send, agentName, pane, { streaming = false } = {}) {
    const start = Date.now();
    let sentCount = 0;
    let lastNewAt = Date.now();
    let lastActivityMsg = "";

    const timer = setInterval(async () => {
      try {
        const raw = await capturePane(agentName, pane, 200);
        const lastTurn = extractLastTurn(raw);
        const segments = extractSegments(classifyLines(lastTurn));

        // Stream complete segments (all except last which may still grow)
        if (streaming && segments.length > 1 && sentCount < segments.length - 1) {
          while (sentCount < segments.length - 1) {
            send(segments[sentCount]).catch(() => {});
            sentCount++;
          }
          lastNewAt = Date.now();
          return;
        }

        // Fallback: show tool activity after 30s silence
        const silent = (Date.now() - lastNewAt) / 1000;
        if (silent >= 30) {
          const label = formatDuration(Math.floor((Date.now() - start) / 1000));
          const activity = await peekActivity(agentName, pane);
          const msg = activity ? `working (${label}) — ${activity}` : `working (${label})`;
          if (msg !== lastActivityMsg) {
            send(msg).catch(() => {});
            lastActivityMsg = msg;
            lastNewAt = Date.now();
          }
        }
      } catch {}
    }, 3000);

    return { timer, sentCount: () => sentCount };
  }

  // --- Context ---

  function getContextPercent(agentDir) {
    try {
      const encoded = agentDir.replace(/[\/\.]/g, "-");
      const projectDir = join(process.env.HOME, ".claude", "projects", encoded);
      const files = readdirSync(projectDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ name: f, mtime: statSync(join(projectDir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (!files.length) return null;
      const content = readFileSync(join(projectDir, files[0].name), "utf-8");
      const lines = content.trimEnd().split("\n");
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
        try {
          const entry = JSON.parse(lines[i]);
          const u = entry?.message?.usage;
          if (u) {
            const total = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) +
              (u.cache_read_input_tokens || 0) + (u.output_tokens || 0);
            return Math.round((total / CONTEXT_MAX) * 100);
          }
        } catch {}
      }
      return null;
    } catch {
      return null;
    }
  }

  // --- Preflight ---

  async function sendEscape(agentName, pane) {
    const target = `${agentName}:.${pane}`;
    await tmuxExec(
      `tmux -S '${tmuxSocket}' send-keys -t '${esc(target)}' Escape`,
    );
  }

  async function capturePane(agentName, pane, lines = 50) {
    const target = `${agentName}:.${pane}`;
    const { stdout } = await tmuxExec(
      `tmux -S '${tmuxSocket}' capture-pane -t '${esc(target)}' -p -S -${lines}`,
    );
    const text = stripAnsi(stdout).trimEnd();
    return text || "(empty)";
  }

  async function checkAgent(agentName) {
    await run(`'${esc(agentBin)}' wait '${esc(agentName)}' -t 3`, 5000);
  }

  return {
    sendAndWait,
    sendOnly,
    getResponse,
    getResponseSegments,
    isBusy,
    capturePane,
    sendEscape,
    dismissBlockingPrompt,
    startProgressTimer,
    getContextPercent,
    checkAgent,
  };
}
