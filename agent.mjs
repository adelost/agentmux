// Agent interaction: send prompts, wait for responses, track progress.
// Manages tmux sessions directly. Single source of truth for claude startup + dismiss.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { load as loadYaml } from "js-yaml";
import { esc, stripAnsi, extractActivity, formatDuration } from "./lib.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments, extractMixedStream, extractTurnByPrompt } from "./core/extract.mjs";
import { detectDialect } from "./core/dialects.mjs";
import { extractFromJsonl } from "./core/jsonl-reader.mjs";

const CONTEXT_MAX = 200_000;
const CLAUDE_FLAGS = "--dangerously-skip-permissions";
// Minimum width for the tmux window. We only force width, not height, so:
//   - Claude's bottom bar renders in full (no "esc to interrup" truncation)
//     which is required for isBusy to catch the busy signal
//   - The window height follows the attached client ('window-size largest'
//     grows it to match the largest attached terminal) so users can see the
//     whole pane when they attach for debugging
const MIN_WINDOW_WIDTH = 300;

// --- Session isolation ---

/** All panes in .agents/N/ for full session isolation. */
export function paneDir(rootDir, pane) {
  const dir = join(rootDir, ".agents", String(pane));
  mkdirSync(dir, { recursive: true });
  ensureGitignored(rootDir, ".agents/");
  return dir;
}

function ensureGitignored(rootDir, entry) {
  const gitignore = join(rootDir, ".gitignore");
  try {
    const content = existsSync(gitignore) ? readFileSync(gitignore, "utf-8") : "";
    if (!content.includes(entry)) {
      writeFileSync(gitignore, content.trimEnd() + "\n" + entry + "\n");
    }
  } catch (err) {
    console.warn(`gitignore update failed: ${err.message}`);
  }
}

// --- Blocking prompts (data-driven) ---

const BLOCKING_PROMPTS = [
  {
    name: "resume",
    match: (text) => text.includes("Resume from summary") && text.includes("Enter to confirm"),
    keys: "Enter",
    waitMs: 3000,
  },
  {
    name: "dismiss",
    match: (text) => text.includes("0: Dismiss"),
    keys: "'0' Enter",
    waitMs: 500,
  },
];

// --- Agent factory ---

export function createAgent({ tmuxSocket, configPath, timeout, delay, run, tmuxExec }) {
  const wait = delay || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const tmux = (cmd) => tmuxExec(`tmux -S '${esc(tmuxSocket)}' ${cmd}`);

  // --- Config ---

  function loadConfig() {
    try { return loadYaml(readFileSync(configPath, "utf-8")) || {}; }
    catch { return {}; }
  }

  function agentConfig(name) {
    const config = loadConfig();
    if (!config[name]?.dir) throw new Error(`Agent '${name}' not found in ${configPath}`);
    return config[name];
  }

  // --- tmux primitives ---

  async function hasSession(name) {
    try { await tmux(`has-session -t '${esc(name)}'`); return true; } catch { return false; }
  }

  async function ensureSession(name) {
    if (await hasSession(name)) return;
    await tmux(`new-session -d -s '${esc(name)}'`);
    await tmux(`source-file ~/.tmux.conf`).catch(() => {});
    await tmux(`set-option -g window-size largest`).catch(() => {});
    await ensureMinWindowSize(name);
  }

  async function ensureMinWindowSize(name) {
    try {
      const { stdout: w } = await tmux(`display -t '${esc(name)}' -p '#{window_width}'`);
      const curW = parseInt(w);
      // Only enforce width. Height is left to tmux + client so users can
      // see the full pane when they attach with their own terminal.
      if (curW < MIN_WINDOW_WIDTH) {
        await tmux(`resize-window -t '${esc(name)}' -x ${MIN_WINDOW_WIDTH}`).catch(() => {});
      }
    } catch {}
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

  // --- Pane setup ---

  async function setupPanes(name, dir) {
    const config = loadConfig();
    const panes = config[name]?.panes || [];
    if (!panes.length) return;

    const existing = await countPanes(name);
    for (let i = existing; i < panes.length; i++) {
      await tmux(`split-window -t '${esc(name)}' -h`).catch(() => {});
    }

    const layout = config[name]?.layout || "main-vertical";
    await tmux(`select-layout -t '${esc(name)}' '${layout}'`).catch(() => {});

    for (let i = 0; i < panes.length; i++) {
      const target = `${name}:.${i}`;
      if (await isAlreadyRunning(target)) continue;

      if (isClaudeCmd(panes[i].cmd)) {
        // Claude panes: skip entirely. startClaude (via ensureReady) does cd + start + dismiss.
        continue;
      } else if (panes[i].defer) {
        await tmux(`send-keys -t '${esc(target)}' 'cd ${esc(dir)}' Enter`);
      } else {
        await tmux(`send-keys -t '${esc(target)}' 'cd ${esc(dir)} && ${panes[i].cmd}' Enter`);
      }
      await wait(500);
    }
    await tmux(`select-pane -t '${esc(name)}:.0'`).catch(() => {});
  }

  async function countPanes(name) {
    try {
      const { stdout } = await tmux(`list-panes -t '${esc(name)}'`);
      return stdout.trim().split("\n").length;
    } catch { return 1; }
  }

  async function isAlreadyRunning(target) {
    try {
      const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_current_command}'`);
      return /claude|node|make|vite|python/.test(stdout.trim());
    } catch { return false; }
  }

  function isClaudeCmd(cmd) {
    return cmd?.includes("claude") || false;
  }

  // --- Claude lifecycle ---

  async function startClaude(name, target, rootDir, pane = 0) {
    if (await isPaneDead(target)) await respawnPane(target);
    if (await isAlreadyRunning(target)) return;

    const dir = paneDir(rootDir, pane);
    const sessionFlag = resolveSessionFlag(dir);
    await tmux(`send-keys -t '${esc(target)}' 'cd ${esc(dir)} && claude ${CLAUDE_FLAGS} ${sessionFlag}' Enter`);
    await wait(2000);
  }

  async function isPaneDead(target) {
    try {
      const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_dead}'`);
      return stdout.trim() === "1";
    } catch { return false; }
  }

  async function respawnPane(target) {
    await tmux(`respawn-pane -t '${esc(target)}' -k`).catch(() => {});
    await wait(500);
  }

  /** --continue if session exists, otherwise no flag (new session). */
  function resolveSessionFlag(dir) {
    const encodedDir = dir.replace(/\//g, "-");
    const projectDir = join(process.env.HOME, ".claude", "projects", encodedDir);
    try {
      if (readdirSync(projectDir).some((f) => f.endsWith(".jsonl"))) return "--continue";
    } catch {}
    return "";
  }

  /** Wait for claude to load, dismiss any blocking prompts if they appear. */
  async function waitForClaudeReady(target, agentName, pane) {
    // Wait for claude process to appear
    for (let i = 0; i < 15; i++) {
      if (await isAlreadyRunning(target)) break;
      await wait(500);
    }

    // Poll for resume/dismiss or idle (old sessions may prompt)
    for (let j = 0; j < 8; j++) {
      await wait(1000);
      const dismissed = await dismissBlockingPrompt(target);
      if (dismissed) return;
      if (!(await isBusy(agentName, pane))) return;
    }
  }

  // --- Dismiss ---

  async function dismissBlockingPrompt(target) {
    let paneText;
    try {
      const { stdout } = await tmux(`capture-pane -t '${esc(target)}' -p -S -20`);
      paneText = stdout;
    } catch (err) {
      console.warn(`dismiss: capture failed for ${target}: ${err.message}`);
      return null;
    }

    for (const prompt of BLOCKING_PROMPTS) {
      if (prompt.match(paneText)) {
        await tmux(`send-keys -t '${esc(target)}' ${prompt.keys}`);
        await wait(prompt.waitMs);
        return prompt.name;
      }
    }
    return null;
  }

  // --- Query ---

  async function getResponse(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    return extractText(raw) || "(empty response)";
  }

  async function isBusy(agentName, pane) {
    const raw = await capturePane(agentName, pane, 20);
    const dialect = detectDialect(raw);

    // Dialect-specific busy signals. Each entry can be a string (substring
    // match) or a RegExp (pattern match) — supports both literal indicators
    // like "esc to interrup" and shape-matchers like /\w+ing…\s*\(/ for
    // thinking verbs (Musing…, Orchestrating…, Doing…).
    const hit = dialect.busySignals?.some((sig) =>
      typeof sig === "string" ? raw.includes(sig) : sig.test(raw),
    );
    if (hit) return true;

    // Dialects that always show a placeholder in their prompt (e.g. Codex)
    // can't use prompt-has-text as a busy signal. Rely on busySignals only.
    if (!dialect.idleWhenPromptEmpty) return false;

    // Dialects with an empty prompt when idle (e.g. Claude Code)
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const tail = lines.slice(-10);
    const promptLine = tail.findLast((l) => l.startsWith(dialect.promptChar));
    if (!promptLine) return true;
    return promptLine.slice(dialect.promptChar.length).trim().length > 0;
  }

  async function getResponseSegments(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    return extractSegments(classifyLines(extractLastTurn(raw)));
  }

  /** Get text + tool calls in order. If promptText given, finds that exact turn. */
  async function getResponseStream(agentName, pane, promptText = null) {
    const { items } = await getResponseStreamWithRaw(agentName, pane, promptText);
    return items;
  }

  /**
   * Same as getResponseStream but also returns raw buffer + turn slice (for recording).
   *
   * Source-of-truth strategy:
   *   1. Prefer Claude's jsonl session file — it has exact text with code fences,
   *      structured tool_use blocks, and no UI rendering artifacts. This eliminates
   *      narrow-pane wordwrap, progress-icon interference, code-block destruction, etc.
   *   2. Fall back to tmux extract if jsonl is missing (Codex or fresh session)
   *      or contains no matching turn (e.g. echo confirmed but claude crashed
   *      before writing the response).
   */
  async function getResponseStreamWithRaw(agentName, pane, promptText = null) {
    const config = agentConfig(agentName);
    const dir = paneDir(config.dir, pane);

    // Try jsonl source of truth first
    const jsonl = extractFromJsonl(dir, promptText);
    if (jsonl && jsonl.items.length > 0) return jsonl;

    // Fallback: tmux parsing (Codex, missing jsonl, or partial write race)
    const raw = await capturePane(agentName, pane, 5000);
    const turn = promptText ? extractTurnByPrompt(raw, promptText) : extractLastTurn(raw);
    const items = extractMixedStream(classifyLines(turn));
    return { raw, turn, items, source: "tmux" };
  }

  async function capturePane(agentName, pane, lines = 50) {
    // -J joins wrapped lines into single logical lines. Without this, narrow
    // panes (e.g. 42-col panes in main-vertical layouts) split the prompt and
    // response across multiple lines, confusing extract which treats
    // continuation lines as new text segments.
    const { stdout } = await tmux(`capture-pane -t '${esc(agentName)}:.${pane}' -p -J -S -${lines}`);
    return stripAnsi(stdout).trimEnd() || "(empty)";
  }

  /**
   * Poll the pane until the user's prompt text appears in the buffer,
   * confirming the agent has actually received the input.
   *
   * This is the positive signal that replaces the old "wait some ms and hope"
   * approach: no matter how slow the agent is to start processing (cold start,
   * large context, SIGWINCH redraw), we can trust it got the message once we
   * see it echoed back.
   *
   * @returns true if echo seen, false on timeout
   */
  async function waitForPromptEcho(agentName, pane, promptText, timeoutMs = 15000) {
    const needle = promptText.trim().slice(0, 30);
    if (!needle) return true; // empty prompt, nothing to wait for
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const raw = await capturePane(agentName, pane, 100);
      if (raw.includes(needle)) return true;
      await wait(200);
    }
    return false;
  }

  // --- Send ---

  async function sendPrompt(agentName, prompt, pane) {
    const target = `${agentName}:.${pane}`;
    await exitCopyMode(target);

    if (prompt.length > 500) {
      await sendLongPrompt(target, prompt);
    } else {
      await tmux(`send-keys -t '${esc(target)}' -l -- '${esc(prompt)}'`);
      await wait(1000);
    }
    await tmux(`send-keys -t '${esc(target)}' Enter`);
  }

  async function sendLongPrompt(target, prompt) {
    const tmpFile = `/tmp/agentus-prompt-${process.pid}.txt`;
    const bufName = `prompt_${process.pid}_${Date.now()}`;
    writeFileSync(tmpFile, prompt);
    await tmux(`load-buffer -b '${bufName}' '${esc(tmpFile)}'`);
    await tmux(`paste-buffer -b '${bufName}' -t '${esc(target)}'`);
    try { unlinkSync(tmpFile); } catch {}
    await wait(5000);
  }

  // --- Orchestration ---

  async function ensureReady(agentName, pane) {
    const config = agentConfig(agentName);
    const isNew = !(await hasSession(agentName));

    await ensureSession(agentName);
    // Resize every time, not only when session is new. Existing sessions may
    // have shrunk (80 col) which truncates Claude's "esc to interrupt" signal.
    await ensureMinWindowSize(agentName);
    if (isNew) {
      await setupPanes(agentName, config.dir);
      await wait(2000);
    }

    const target = `${agentName}:.${pane}`;
    const paneCmd = config.panes?.[pane]?.cmd || "bash";

    if (isClaudeCmd(paneCmd)) {
      await startClaude(agentName, target, config.dir, pane);
      await waitForClaudeReady(target, agentName, pane);
    }
  }

  async function sendOnly(agentName, prompt, pane) {
    await ensureReady(agentName, pane);
    await sendPrompt(agentName, prompt, pane);
  }

  async function sendAndWait(agentName, prompt, pane) {
    const wasStarting = !(await isAlreadyRunning(`${agentName}:.${pane}`));
    await ensureReady(agentName, pane);
    await sendPrompt(agentName, prompt, pane);

    await wait(wasStarting ? 8000 : 3000);

    const deadline = Date.now() + timeout;
    let sawWorking = false;
    let idleStreak = 0;

    while (Date.now() < deadline) {
      await exitCopyMode(`${agentName}:.${pane}`);
      const busy = await isBusy(agentName, pane);

      if (busy) { sawWorking = true; idleStreak = 0; }
      else {
        idleStreak += 2;
        if (sawWorking && idleStreak >= 2) break;
        if (!sawWorking && idleStreak >= 4) break;
      }
      await wait(2000);
    }

    await dismissBlockingPrompt(`${agentName}:.${pane}`);
    return getResponse(agentName, pane);
  }

  // --- Progress ---

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
        const segments = await getResponseSegments(agentName, pane);

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

  function getContextPercent(agentDir, pane = 0) {
    try {
      // Read from the pane's actual dir (.agents/N/) where Claude stores its session
      const dir = paneDir(agentDir, pane);
      const encoded = dir.replace(/[\/\.]/g, "-");
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

  // --- Low-level (exposed for CLI) ---

  async function sendEscape(agentName, pane) {
    await tmux(`send-keys -t '${esc(agentName)}:.${pane}' Escape`);
  }

  async function checkAgent(agentName) {
    if (!(await hasSession(agentName))) throw new Error(`No session: ${agentName}`);
    if (!(await isAlreadyRunning(`${agentName}:.0`))) throw new Error(`Claude not running in ${agentName}`);
  }

  return {
    ensureReady, sendAndWait, sendOnly,
    getResponse, getResponseSegments, getResponseStream, getResponseStreamWithRaw, isBusy,
    capturePane, sendEscape, dismissBlockingPrompt, waitForPromptEcho,
    startProgressTimer, getContextPercent, checkAgent,
  };
}
