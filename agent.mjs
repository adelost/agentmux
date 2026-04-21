// Agent interaction: send prompts, wait for responses, track progress.
// Manages tmux sessions directly. Single source of truth for claude startup + dismiss.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { join } from "path";
import { load as loadYaml } from "js-yaml";
import { esc, stripAnsi } from "./lib.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments, extractMixedStream, extractTurnByPrompt } from "./core/extract.mjs";
import { detectDialect } from "./core/dialects.mjs";
import { extractFromJsonl, isBusyFromJsonl, isPromptInJsonl } from "./core/jsonl-reader.mjs";
import { extractFromCodexJsonl, isBusyFromCodexJsonl, isPromptInCodexJsonl } from "./core/codex-jsonl-reader.mjs";
import { getContextPercent as getContextPercentByDialect } from "./core/context.mjs";
import { findBlockingPrompt } from "./core/dismiss.mjs";
import { startProgressTimer as createProgressTimer } from "./core/progress.mjs";

const CLAUDE_FLAGS = "--dangerously-skip-permissions";

// --- Session isolation ---

/** All panes in .agents/N/ for full session isolation. */
export function paneDir(rootDir, pane) {
  const dir = join(rootDir, ".agents", String(pane));
  mkdirSync(dir, { recursive: true });
  ensureGitignored(rootDir, ".agents/");
  ensureAgentHints(rootDir);
  return dir;
}

// Placed in .agents/CLAUDE.md so Claude Code auto-reads it from any pane
// (panes run in .agents/N/, Claude searches upward for CLAUDE.md).
// Survives /compact because CLAUDE.md is system context, not conversation.
const AGENT_HINTS = `# agentmux

You are running inside agentmux. You can orchestrate other agents from your terminal.

## Available commands

\`\`\`bash
amux ps                          # show all agents and their status
amux log <agent>                 # see another agent's last response
amux <agent> "do something"      # send a task to another agent
amux wait <agent>                # wait until an agent finishes
amux esc <agent>                 # interrupt an agent
\`\`\`

## Examples

\`\`\`bash
# Ask the api agent to run tests, wait for result, read the output
amux api "run all tests" && amux wait api && amux log api

# Check what all agents are doing
amux ps

# Fan-out: send tasks to multiple agents in parallel
amux frontend "update dashboard" & amux backend "add endpoint" & wait
\`\`\`

## Image replies

To attach an image to your Discord reply, write on its own line:

\`\`\`
[image: /absolute/path/to/file.png]
\`\`\`

Supported formats: .png, .jpg, .jpeg, .gif, .webp (max 25MB).

## Root cause > symptoms

Always fix the cause, not the symptom. Before patching, ask *why* it's happening.

- ❌ Test fails → skip the test
- ✅ Test fails → is the test wrong, or the code?
- ❌ Hook blocks commit → --no-verify
- ✅ Hook blocks → why? fix the underlying issue
- ❌ Error in prod → wrap in try/catch and swallow
- ✅ Error in prod → trace the path, fix the source

Quick workaround is OK when deliberate (time pressure, experiment) — but **call it out**: "patching surface, root cause is X, fix later."
`;

// Write hints as both CLAUDE.md (for Claude Code) and AGENTS.md (for Codex).
// Both tools auto-read their respective file from cwd upward.
function ensureAgentHints(rootDir) {
  const agentsDir = join(rootDir, ".agents");
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const path = join(agentsDir, name);
    try {
      if (!existsSync(path)) writeFileSync(path, AGENT_HINTS);
    } catch (err) {
      console.warn(`agent hints write failed (${name}): ${err.message}`);
    }
  }
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
    await tmux(`source-file ~/.tmux.conf`).catch((err) =>
      console.warn(`tmux: source-file .tmux.conf failed: ${err.message}`));
    // Let tmux handle window sizing naturally. We used to force a minimum
    // window width to prevent Claude's bottom bar from truncating
    // "esc to interrupt", but busy-signal detection now matches the
    // truncated form "esc to interrup" directly (see dialects.mjs), so
    // the width-forcing was both useless (narrow panes still truncated)
    // and harmful (fought the attached client's terminal geometry).
  }

  async function exitCopyMode(target) {
    try {
      const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_in_mode}'`);
      if (stdout.trim() === "1") {
        await tmux(`send-keys -t '${esc(target)}' q`);
        await wait(300);
      }
    } catch (err) {
      // Target pane may not exist yet, expected during startup. Log only
      // if this looks unexpected (anything other than "no such pane").
      if (!/no such/.test(err.message || "")) {
        console.warn(`exitCopyMode(${target}) failed: ${err.message}`);
      }
    }
  }

  // --- Pane setup ---

  async function setupPanes(name, dir) {
    const config = loadConfig();
    const panes = config[name]?.panes || [];
    if (!panes.length) return;

    const existing = await countPanes(name);
    for (let i = existing; i < panes.length; i++) {
      await tmux(`split-window -t '${esc(name)}' -h`).catch((err) =>
        console.warn(`setupPanes: split-window ${name} failed: ${err.message}`));
    }

    const layout = config[name]?.layout || "main-vertical";
    await tmux(`select-layout -t '${esc(name)}' '${layout}'`).catch((err) =>
      console.warn(`setupPanes: select-layout ${layout} failed: ${err.message}`));

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
    await tmux(`select-pane -t '${esc(name)}:.0'`).catch((err) =>
      console.warn(`setupPanes: select-pane 0 failed: ${err.message}`));
  }

  async function countPanes(name) {
    try {
      const { stdout } = await tmux(`list-panes -t '${esc(name)}'`);
      return stdout.trim().split("\n").length;
    } catch (err) {
      // Session may not exist yet, treat as 1 default pane
      return 1;
    }
  }

  async function isAlreadyRunning(target) {
    try {
      const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_current_command}'`);
      // Pane is "free" only if a shell is at the prompt. Anything else
      // (claude, rclone, ssh, vim, tail, ...) means a process owns the
      // pane — don't send-keys into it, they'd land as stdin to that process.
      return !/^(bash|zsh|fish|sh|dash)$/.test(stdout.trim());
    } catch {
      // Target doesn't exist → not running
      return false;
    }
  }

  function isClaudeCmd(cmd) {
    return cmd?.includes("claude") || false;
  }

  function isShellProc(cmd) {
    return /^(bash|zsh|fish|sh|dash)$/.test(cmd);
  }

  // True when a pane's current process matches the type expected by config.
  // Services are matched loosely: any non-shell, non-claude process is assumed
  // to be the configured service (npm/make/etc spawn varied binaries).
  function paneTypeMatches(currCmd, wantCmd) {
    if (isClaudeCmd(wantCmd)) return /^(claude|node)$/.test(currCmd);
    if (wantCmd === "bash") return isShellProc(currCmd);
    return !isShellProc(currCmd) && !/^(claude|node)$/.test(currCmd);
  }

  // --- Reconciliation ---

  /**
   * Align a live tmux session with its config: add missing panes, respawn panes
   * whose current process doesn't match the configured command type. Leaves
   * correctly-matching panes untouched (preserves running claude/service state).
   *
   * Claude panes that get respawned are left as idle shells; startClaude runs
   * on demand next time the pane is used.
   */
  async function reconcileSession(name) {
    const config = loadConfig();
    const cfg = config[name];
    if (!cfg?.panes?.length) return { skipped: true, reason: "no config" };
    if (!(await hasSession(name))) return { skipped: true, reason: "no session" };

    const summary = { name, added: 0, respawned: [], unchanged: 0, extras: 0 };
    const wanted = cfg.panes;

    const currentCount = await countPanes(name);
    for (let i = currentCount; i < wanted.length; i++) {
      try {
        await tmux(`split-window -t '${esc(name)}' -h`);
        summary.added++;
      } catch (err) {
        console.warn(`reconcile: split-window ${name} failed: ${err.message}`);
      }
    }
    if (summary.added > 0) {
      const layout = cfg.layout || "main-vertical";
      await tmux(`select-layout -t '${esc(name)}' '${layout}'`).catch(() => {});
    }
    if (currentCount > wanted.length) summary.extras = currentCount - wanted.length;

    for (let i = 0; i < wanted.length; i++) {
      const target = `${name}:.${i}`;
      const want = wanted[i];
      let currCmd = "";
      try {
        const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_current_command}'`);
        currCmd = stdout.trim();
      } catch { continue; }

      if (paneTypeMatches(currCmd, want.cmd)) { summary.unchanged++; continue; }

      // Safety: never respawn a pane that's running claude, even if config
      // says something else. User may have active work there; forcing a slot
      // into a shell would destroy context. Report as a mismatch instead.
      if (/^(claude|node)$/.test(currCmd)) {
        summary.mismatches = summary.mismatches || [];
        summary.mismatches.push({ pane: i, has: currCmd, expected: want.name });
        continue;
      }

      // Only respawn panes where the current process is a shell (idle) or a
      // clearly non-interactive process (tail, rclone, etc). This is what
      // fixes the original bug: pane has `tail` but config wants claude.
      try {
        if (isClaudeCmd(want.cmd) || want.cmd === "bash") {
          // Leave as shell; startClaude runs on demand when pane is used.
          await tmux(`respawn-pane -k -t '${esc(target)}' -c '${esc(cfg.dir)}'`);
        } else {
          await tmux(`respawn-pane -k -t '${esc(target)}' -c '${esc(cfg.dir)}' '${esc(want.cmd)}'`);
        }
        summary.respawned.push({ pane: i, was: currCmd, expected: want.name });
      } catch (err) {
        console.warn(`reconcile: respawn ${target} failed: ${err.message}`);
      }
    }

    return summary;
  }

  // --- Claude lifecycle ---

  async function startClaude(name, target, rootDir, pane = 0) {
    if (await isPaneDead(target)) await respawnPane(target);
    if (await isAlreadyRunning(target)) return;

    const dir = paneDir(rootDir, pane);
    const sessionFlag = resolveSessionFlag(dir);
    await tmux(`send-keys -t '${esc(target)}' 'cd ${esc(dir)} && ANTHROPIC_DISABLE_SURVEY=1 claude ${CLAUDE_FLAGS} ${sessionFlag}' Enter`);
    await wait(2000);
  }

  async function isPaneDead(target) {
    try {
      const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_dead}'`);
      return stdout.trim() === "1";
    } catch {
      // Target doesn't exist → not dead (doesn't exist yet)
      return false;
    }
  }

  async function respawnPane(target) {
    // Record the old pid so we can confirm the new shell forked. Without
    // this, the 500ms hard-wait was either wasteful (shell ready in 50ms)
    // or insufficient (tmux hadn't finished respawning yet), and the
    // subsequent `cd && claude` send-keys could go to a pty that hadn't
    // been wired to a readline loop yet.
    let oldPid = "";
    try {
      const { stdout } = await tmux(`display-message -t '${esc(target)}' -p '#{pane_pid}'`);
      oldPid = stdout.trim();
    } catch {
      // pane may not exist yet or be fully dead, treat as unknown pid
    }

    try {
      await tmux(`respawn-pane -t '${esc(target)}' -k`);
    } catch (err) {
      console.warn(`respawnPane(${target}) failed: ${err.message}`);
      return;
    }

    // Poll for a new shell pid to appear. Tmux send-keys buffers to the
    // pty even before readline is active, so as long as the fork happened
    // we're safe to start sending commands. .bashrc will consume them
    // once it finishes initializing.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const [pidRes, cmdRes] = await Promise.all([
          tmux(`display-message -t '${esc(target)}' -p '#{pane_pid}'`),
          tmux(`display-message -t '${esc(target)}' -p '#{pane_current_command}'`),
        ]);
        const newPid = pidRes.stdout.trim();
        const cmd = cmdRes.stdout.trim();
        if (newPid && newPid !== oldPid && /^(bash|zsh|sh|fish|dash)$/.test(cmd)) return;
      } catch {
        // keep polling
      }
      await wait(100);
    }
    console.warn(`respawnPane(${target}) timed out waiting for new shell`);
  }

  /** --continue if session exists, otherwise no flag (new session). */
  function resolveSessionFlag(dir) {
    // Claude Code encodes project dirs by replacing both / and . with -
    const encodedDir = dir.replace(/[\/\.]/g, "-");
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
      const { stdout } = await tmux(`capture-pane -t '${esc(target)}' -J -p -S -20`);
      paneText = stdout;
    } catch (err) {
      console.warn(`dismiss: capture failed for ${target}: ${err.message}`);
      return null;
    }

    const prompt = findBlockingPrompt(paneText);
    if (!prompt) return null;

    await tmux(`send-keys -t '${esc(target)}' ${prompt.keys}`);
    await wait(prompt.waitMs);
    return prompt.name;
  }

  // --- Query ---

  async function getResponse(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    return extractText(raw) || "(empty response)";
  }

  /** Derive which agent dialect a pane runs from its configured cmd. */
  function paneDialectName(agentName, pane) {
    try {
      const config = agentConfig(agentName);
      const cmd = config.panes?.[pane]?.cmd || "";
      if (cmd.includes("codex")) return "codex";
      if (cmd.includes("claude")) return "claude";
      return null;
    } catch (err) {
      console.warn(`paneDialectName(${agentName}) failed: ${err.message}`);
      return null;
    }
  }

  async function isBusy(agentName, pane, promptText = null) {
    // Source of truth: read the agent's own session file instead of parsing
    // tmux rendering. Dispatch on the pane's configured cmd so we don't
    // cross-read another agent's jsonl (cdx and claw can share pane dirs).
    try {
      const config = agentConfig(agentName);
      const dir = paneDir(config.dir, pane);
      const dialect = paneDialectName(agentName, pane);

      if (dialect === "codex") {
        const r = isBusyFromCodexJsonl(dir);
        if (r !== null) return r;
      } else if (dialect === "claude") {
        const r = isBusyFromJsonl(dir, promptText);
        if (r !== null) return r;
        // jsonl exists but our prompt isn't there yet. Claude hasn't
        // written it. Assume busy so we keep polling. workMaxMs is the
        // safety escape if this never resolves.
        return true;
      }
    } catch (err) {
      console.warn(`isBusy(${agentName}) dispatch failed, falling back to tmux: ${err.message}`);
    }

    // Fallback: tmux parsing (Codex, missing jsonl, no matching prompt yet)
    const raw = await capturePane(agentName, pane, 20);
    const dialect = detectDialect(raw);

    // Dialect-specific busy signals. Each entry can be a string (substring
    // match) or a RegExp (pattern match). Supports both literal indicators
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
   *   1. Prefer Claude's jsonl session file. It has exact text with code fences,
   *      structured tool_use blocks, and no UI rendering artifacts. This eliminates
   *      narrow-pane wordwrap, progress-icon interference, code-block destruction, etc.
   *   2. Fall back to tmux extract if jsonl is missing (Codex or fresh session)
   *      or contains no matching turn (e.g. echo confirmed but claude crashed
   *      before writing the response).
   */
  async function getResponseStreamWithRaw(agentName, pane, promptText = null) {
    const config = agentConfig(agentName);
    const dir = paneDir(config.dir, pane);
    const dialect = paneDialectName(agentName, pane);

    // Dispatch to the pane's actual dialect, not trial-and-error. Otherwise
    // cdx and claw (which can share pane dirs like .agents/0/) would read
    // each other's jsonl files.
    if (dialect === "codex") {
      const codex = extractFromCodexJsonl(dir, promptText);
      if (codex && codex.items.length > 0) return codex;
    } else if (dialect === "claude") {
      const claude = extractFromJsonl(dir, promptText);
      if (claude && claude.items.length > 0) return claude;
    }

    // Last-resort fallback: tmux parsing
    const raw = await capturePane(agentName, pane, 5000);
    const turn = promptText ? extractTurnByPrompt(raw, promptText) : extractLastTurn(raw);
    const items = extractMixedStream(classifyLines(turn));
    return { raw, turn, items, source: "tmux" };
  }

  /**
   * True when the source-of-truth session store already contains response
   * items for this exact prompt. No tmux fallback here, we only want a
   * positive signal from structured data.
   */
  function hasResponseForPrompt(agentName, pane, promptText) {
    const needle = promptText?.trim();
    if (!needle) return false;

    const config = agentConfig(agentName);
    const dir = paneDir(config.dir, pane);
    const dialect = paneDialectName(agentName, pane);

    if (dialect === "codex") {
      const codex = extractFromCodexJsonl(dir, promptText);
      return Boolean(codex?.items?.length);
    }
    if (dialect === "claude") {
      const claude = extractFromJsonl(dir, promptText);
      return Boolean(claude?.items?.length);
    }
    return false;
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
   * Source of truth: the agent's own session jsonl. When the user prompt
   * appears there, we know for certain the agent received it. No tmux
   * pane width tricks, no wordwrap to fight. Falls back to tmux text
   * matching when no jsonl is available.
   *
   * @returns true if echo seen, false on timeout
   */
  async function waitForPromptEcho(agentName, pane, promptText, timeoutMs = 15000) {
    const needle = promptText?.trim();
    if (!needle) return true;

    const dir = paneDir(agentConfig(agentName).dir, pane);
    const dialect = paneDialectName(agentName, pane);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // Try jsonl first (width-independent, reliable)
      let found = null;
      if (dialect === "claude") found = isPromptInJsonl(dir, promptText);
      else if (dialect === "codex") found = isPromptInCodexJsonl(dir, promptText);
      if (found === true) return true;

      // Fallback: tmux text match for unknown dialects or when jsonl is
      // missing entirely. Use a short needle so narrow panes still match.
      if (found === null) {
        const raw = await capturePane(agentName, pane, 100);
        if (raw.includes(needle.slice(0, 20))) return true;
      }

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
    const tmpFile = `/tmp/agentmux-prompt-${process.pid}.txt`;
    const bufName = `prompt_${process.pid}_${Date.now()}`;
    writeFileSync(tmpFile, prompt);
    await tmux(`load-buffer -b '${bufName}' '${esc(tmpFile)}'`);
    await tmux(`paste-buffer -b '${bufName}' -t '${esc(target)}'`);
    try { unlinkSync(tmpFile); } catch (err) {
      console.warn(`sendLongPrompt: cleanup ${tmpFile} failed: ${err.message}`);
    }
    await wait(5000);
  }

  // --- Orchestration ---

  async function ensureReady(agentName, pane) {
    const config = agentConfig(agentName);
    const isNew = !(await hasSession(agentName));

    await ensureSession(agentName);
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

  // --- Progress timer (thin wrapper around core/progress.mjs) ---

  function startProgressTimer(send, agentName, pane, opts = {}) {
    return createProgressTimer({
      send,
      getSegments: () => getResponseSegments(agentName, pane),
      capturePane: async () => {
        try {
          const { stdout } = await tmux(`capture-pane -t '${esc(agentName)}:.${pane}' -J -p -S -10`);
          return stdout;
        } catch (err) {
          console.warn(`progress capturePane failed: ${err.message}`);
          return null;
        }
      },
    }, opts);
  }

  // --- Context ---

  /**
   * Get { percent, tokens } for a pane. Dispatches to the right session
   * store based on the pane's configured cmd (claude vs codex).
   */
  function getContextPercent(agentName, pane = 0) {
    try {
      const config = agentConfig(agentName);
      const dir = paneDir(config.dir, pane);
      const dialect = paneDialectName(agentName, pane);
      return getContextPercentByDialect(dir, dialect);
    } catch (err) {
      console.warn(`getContextPercent(${agentName}) failed: ${err.message}`);
      return null;
    }
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
    getResponse, getResponseSegments, getResponseStream, getResponseStreamWithRaw, hasResponseForPrompt, isBusy,
    capturePane, sendEscape, dismissBlockingPrompt, waitForPromptEcho,
    startProgressTimer, getContextPercent, checkAgent, reconcileSession,
  };
}
