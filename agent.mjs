// Agent interaction: send prompts, wait for responses, track progress.
// Manages tmux sessions directly — no external bash scripts needed.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { load as loadYaml } from "js-yaml";
import { esc, stripAnsi, extractActivity, formatDuration } from "./lib.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments } from "./core/extract.mjs";

const CONTEXT_MAX = 200_000;
const CLAUDE_FLAGS = "--dangerously-skip-permissions";
const MIN_WINDOW_WIDTH = 300;
const MIN_WINDOW_HEIGHT = 80;

/** Get working dir for a pane. Pane 0 = root, pane N = root/.agents/N/ (session isolation). */
export function paneDir(rootDir, pane) {
  if (pane === 0) return rootDir;
  const dir = join(rootDir, ".agents", String(pane));
  mkdirSync(dir, { recursive: true });
  // Ensure .agents is gitignored
  const gitignore = join(rootDir, ".gitignore");
  try {
    const content = existsSync(gitignore) ? readFileSync(gitignore, "utf-8") : "";
    if (!content.includes(".agents")) {
      writeFileSync(gitignore, content.trimEnd() + "\n.agents/\n");
    }
  } catch {}
  return dir;
}

export function createAgent({ tmuxSocket, configPath, timeout, delay, run, tmuxExec }) {
  const wait = delay || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // --- Config (YAML) ---

  function loadConfig() {
    try {
      return loadYaml(readFileSync(configPath, "utf-8")) || {};
    } catch {
      return {};
    }
  }

  function getAgentConfig(name) {
    const config = loadConfig();
    if (!config[name]?.dir) throw new Error(`Agent '${name}' not found in ${configPath}`);
    return config[name];
  }

  function getPaneCmd(name, idx) {
    const config = loadConfig();
    return config[name]?.panes?.[idx]?.cmd || "bash";
  }

  function isDeferred(name, idx) {
    const config = loadConfig();
    return config[name]?.panes?.[idx]?.defer === true;
  }

  function getLayout(name) {
    const config = loadConfig();
    return config[name]?.layout || "main-vertical";
  }

  // --- tmux helpers ---

  const tmux = (cmd) => tmuxExec(`tmux -S '${esc(tmuxSocket)}' ${cmd}`);

  async function hasSession(name) {
    try { await tmux(`has-session -t '${esc(name)}'`); return true; } catch { return false; }
  }

  async function ensureSession(name) {
    if (await hasSession(name)) return;
    await tmux(`new-session -d -s '${esc(name)}'`);
    await tmux(`source-file ~/.tmux.conf`).catch(() => {});
    await tmux(`set-option -g window-size largest`).catch(() => {});
    // Ensure minimum window size
    try {
      const { stdout: w } = await tmux(`display -t '${esc(name)}' -p '#{window_width}'`);
      const { stdout: h } = await tmux(`display -t '${esc(name)}' -p '#{window_height}'`);
      const curW = parseInt(w), curH = parseInt(h);
      if (curW < MIN_WINDOW_WIDTH || curH < MIN_WINDOW_HEIGHT) {
        const newW = Math.max(curW, MIN_WINDOW_WIDTH);
        const newH = Math.max(curH, MIN_WINDOW_HEIGHT);
        await tmux(`resize-window -t '${esc(name)}' -x ${newW} -y ${newH}`).catch(() => {});
      }
    } catch {}
  }

  async function setupPanes(name, dir) {
    const config = loadConfig();
    const panes = config[name]?.panes || [];
    if (!panes.length) return;

    // Count existing panes
    let existing = 1;
    try {
      const { stdout } = await tmux(`list-panes -t '${esc(name)}'`);
      existing = stdout.trim().split("\n").length;
    } catch {}

    // Create additional panes
    for (let i = existing; i < panes.length; i++) {
      await tmux(`split-window -t '${esc(name)}' -h`).catch(() => {});
    }

    // Apply layout
    await tmux(`select-layout -t '${esc(name)}' '${getLayout(name)}'`).catch(() => {});

    // Start commands in each pane
    for (let i = 0; i < panes.length; i++) {
      const target = `${name}:.${i}`;

      // Skip if something is already running
      try {
        const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_current_command}'`);
        const cmd = stdout.trim();
        if (/claude|node|make|vite|python/.test(cmd)) continue;
      } catch {}

      const workDir = panes[i].cmd?.includes("claude") ? paneDir(dir, i) : dir;
      if (isDeferred(name, i)) {
        await tmux(`send-keys -t '${esc(target)}' 'cd ${esc(workDir)}' Enter`);
      } else {
        await tmux(`send-keys -t '${esc(target)}' 'cd ${esc(workDir)} && ${panes[i].cmd}' Enter`);
      }
      await wait(500);
    }

    await tmux(`select-pane -t '${esc(name)}:.0'`).catch(() => {});
  }

  async function startClaude(name, target, rootDir, id, pane = 0) {
    // Check if pane is dead
    try {
      const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_dead}'`);
      if (stdout.trim() === "1") {
        await tmux(`respawn-pane -t '${esc(target)}' -k`).catch(() => {});
        await wait(500);
      }
    } catch {}

    // Check if claude is already running
    try {
      const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_current_command}'`);
      if (/claude|node/.test(stdout.trim())) return;
    } catch {}

    // Pane 0 = root, pane N = .agents/N/ (isolated session history)
    const dir = paneDir(rootDir, pane);

    // Determine session flag
    const encodedDir = dir.replace(/\//g, "-");
    const projectDir = join(process.env.HOME, ".claude", "projects", encodedDir);
    let sessionFlag = `--session-id ${id}`;
    try {
      const files = readdirSync(projectDir).filter((f) => f.endsWith(".jsonl"));
      if (files.length) sessionFlag = "--continue";
    } catch {}

    await tmux(`send-keys -t '${esc(target)}' 'cd ${esc(dir)} && claude ${CLAUDE_FLAGS} ${sessionFlag}' Enter`);
    await wait(2000);
  }

  async function exitCopyMode(target) {
    try {
      const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_in_mode}'`);
      if (stdout.trim() === "1") {
        await tmux(`send-keys -t '${esc(target)}' q`);
        await wait(300);
      }
    } catch {}
  }

  // --- Dismiss blocking prompts ---

  /** Auto-select "Resume from summary" when Claude asks about old sessions. */
  async function dismissResumePrompt(target) {
    try {
      const { stdout } = await tmux(`capture-pane -t '${esc(target)}' -p -S -20`);
      if (stdout.includes("Resume from summary") && stdout.includes("Enter to confirm")) {
        // Option 1 is already selected by default, just press Enter
        await tmux(`send-keys -t '${esc(target)}' Enter`);
        await wait(3000);
        return true;
      }
    } catch {}
    return false;
  }

  async function dismissBlockingPrompt(target) {
    // Check for resume prompt first
    if (await dismissResumePrompt(target)) return true;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { stdout } = await tmux(`capture-pane -t '${esc(target)}' -p`);
        const lastLines = stdout.trimEnd().split("\n").slice(-3).join("\n");
        if (!lastLines.includes("0: Dismiss")) return false;
        await tmux(`send-keys -t '${esc(target)}' '0' Enter`);
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

  async function isBusy(agentName, pane) {
    const raw = await capturePane(agentName, pane, 20);
    // "esc to interrupt" = definitely working (most reliable signal)
    if (raw.includes("esc to interrupt")) return true;
    // Search last ~10 lines for ❯ prompt (status lines, Welter, separators may follow it)
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const tail = lines.slice(-10);
    const promptLine = tail.findLast((l) => l.startsWith("❯"));
    if (!promptLine) return true;                          // no prompt visible = working
    if (promptLine.replace(/^❯\s*/, "").length > 0) return true; // has pending input
    return false;                                          // idle
  }

  async function getResponseSegments(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    const lastTurn = extractLastTurn(raw);
    return extractSegments(classifyLines(lastTurn));
  }

  // --- Send prompt ---

  async function sendPrompt(agentName, prompt, pane) {
    const target = `${agentName}:.${pane}`;
    await exitCopyMode(target);

    // Long prompts: use paste-buffer to avoid truncation
    if (prompt.length > 500) {
      const tmpFile = `/tmp/agentus-prompt-${process.pid}.txt`;
      const bufName = `prompt_${process.pid}_${Date.now()}`;
      writeFileSync(tmpFile, prompt);
      await tmux(`load-buffer -b '${bufName}' '${esc(tmpFile)}'`);
      await tmux(`paste-buffer -b '${bufName}' -t '${esc(target)}'`);
      try { unlinkSync(tmpFile); } catch {}
      await wait(5000);
    } else {
      await tmux(`send-keys -t '${esc(target)}' -l -- '${esc(prompt)}'`);
      await wait(1000);
    }
    await tmux(`send-keys -t '${esc(target)}' Enter`);
  }

  async function ensureReady(agentName, pane) {
    const config = getAgentConfig(agentName);
    const dir = config.dir;
    const isNew = !(await hasSession(agentName));

    await ensureSession(agentName);

    if (isNew) {
      await setupPanes(agentName, dir);
      await wait(2000);
    }

    const target = `${agentName}:.${pane}`;
    const paneCmd = getPaneCmd(agentName, pane);

    // Ensure claude is running in claude panes
    if (paneCmd.includes("claude")) {
      await startClaude(agentName, target, dir, config.id, pane);
    }

    // Wait for claude to be loaded
    for (let i = 0; i < 20; i++) {
      try {
        const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_current_command}'`);
        if (/claude|node/.test(stdout.trim())) {
          await wait(1000);
          // Handle resume prompt that appears on old sessions
          await dismissResumePrompt(target);
          return;
        }
      } catch {}
      await wait(500);
    }
  }

  // --- Public API ---

  async function sendOnly(agentName, prompt, pane) {
    await ensureReady(agentName, pane);
    await sendPrompt(agentName, prompt, pane);
  }

  async function sendAndWait(agentName, prompt, pane) {
    let wasStarting = false;
    try {
      const { stdout } = await tmux(`display-message -t '${esc(agentName)}:.${pane}' -p '#{pane_current_command}'`);
      if (!stdout.trim().includes("claude")) wasStarting = true;
    } catch { wasStarting = true; }

    await ensureReady(agentName, pane);
    await sendPrompt(agentName, prompt, pane);

    // Wait for agent to start working, then finish
    await wait(wasStarting ? 8000 : 3000);

    const deadline = Date.now() + timeout;
    let sawWorking = false;
    let idleStreak = 0;

    while (Date.now() < deadline) {
      const target = `${agentName}:.${pane}`;
      await exitCopyMode(target);
      const busy = await isBusy(agentName, pane);

      if (busy) { sawWorking = true; idleStreak = 0; }
      else {
        idleStreak += 2;
        if (sawWorking && idleStreak >= 2) break;
        if (!sawWorking && idleStreak >= 4) break;
      }
      await wait(2000);
    }

    const target = `${agentName}:.${pane}`;
    await dismissBlockingPrompt(target);
    return getResponse(agentName, pane);
  }

  // --- Activity / progress ---

  async function peekActivity(agentName, pane) {
    try {
      const { stdout } = await tmux(`capture-pane -t '${esc(agentName)}:.${pane}' -p -S -10`);
      return extractActivity(stdout);
    } catch { return null; }
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

        if (streaming && segments.length > 1 && sentCount < segments.length - 1) {
          while (sentCount < segments.length - 1) {
            send(segments[sentCount]).catch(() => {});
            sentCount++;
          }
          lastNewAt = Date.now();
          return;
        }

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
            return { percent: Math.round((total / CONTEXT_MAX) * 100), tokens: total };
          }
        } catch {}
      }
      return null;
    } catch { return null; }
  }

  // --- Low-level ---

  async function sendEscape(agentName, pane) {
    await tmux(`send-keys -t '${esc(agentName)}:.${pane}' Escape`);
  }

  async function capturePane(agentName, pane, lines = 50) {
    const target = `${agentName}:.${pane}`;
    const { stdout } = await tmux(`capture-pane -t '${esc(target)}' -p -S -${lines}`);
    const text = stripAnsi(stdout).trimEnd();
    return text || "(empty)";
  }

  async function checkAgent(agentName) {
    // Quick check: session exists and claude is running
    if (!(await hasSession(agentName))) throw new Error(`No session: ${agentName}`);
    const { stdout } = await tmux(`display-message -t '${esc(agentName)}:.0' -p '#{pane_current_command}'`);
    if (!/claude|node/.test(stdout.trim())) throw new Error(`Claude not running in ${agentName}`);
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
