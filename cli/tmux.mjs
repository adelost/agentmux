// Tmux facade for agent CLI. Bridges agent.mjs primitives with CLI-specific operations.
// Stateless: all functions take socket + target explicitly.

import { exec as execCb, execSync } from "child_process";
import { promisify } from "util";
import { createAgent } from "../agent.mjs";
import { esc, stripAnsi } from "../lib.mjs";
import { detectPaneStatus } from "./format.mjs";

const exec = promisify(execCb);

/** Create tmux execution helpers bound to a socket. */
export function createTmuxContext(socket, configPath) {
  const tmuxExec = (cmd) => exec(cmd, { timeout: 5000 });
  const run = (cmd, t = 30000) => exec(cmd, { timeout: t, maxBuffer: 1024 * 1024 });
  const tmux = (cmd) => tmuxExec(`tmux -S '${esc(socket)}' ${cmd}`);

  const agent = createAgent({ tmuxSocket: socket, configPath, timeout: 600000, run, tmuxExec });

  return { tmux, tmuxExec, run, agent, socket };
}

/** Check if a tmux session exists. */
export async function hasSession(ctx, name) {
  try {
    await ctx.tmux(`has-session -t '${esc(name)}'`);
    return true;
  } catch {
    return false;
  }
}

/** Attach to a tmux session. Must not be called from inside tmux. */
export function attachSession(socket, name) {
  execSync(`tmux -S '${esc(socket)}' attach-session -t '${esc(name)}'`, { stdio: "inherit" });
}

/** Ensure session exists with all panes set up and claude started. */
export async function ensureAndAttach(ctx, name, configPath) {
  const isNew = !(await hasSession(ctx, name));

  if (isNew) {
    // Create session
    await ctx.tmux(`new-session -d -s '${esc(name)}'`);
    await ctx.tmux(`source-file ~/.tmux.conf`).catch(() => {});
    await ctx.tmux(`set-option -g window-size largest`).catch(() => {});
  }

  // Setup panes + start claude via agent.mjs (handles dismiss automatically)
  // We trigger ensureReady for pane 0 which sets up all panes if new
  await ctx.agent.sendOnly(name, "", 0).catch(() => {});

  // Wait briefly for panes to initialize
  if (isNew) {
    await new Promise((r) => setTimeout(r, 3000));
    // Start claude in remaining panes
    const { loadConfig } = await import("./config.mjs");
    const config = loadConfig(configPath);
    const panes = config[name]?.panes || [];
    for (let i = 1; i < panes.length; i++) {
      if (panes[i]?.cmd?.includes("claude")) {
        await ctx.agent.sendOnly(name, "", i).catch(() => {});
      }
    }
  }
}

/** Kill a tmux session. */
export async function killSession(ctx, name) {
  await ctx.tmux(`kill-session -t '${esc(name)}'`);
}

/** List panes in a session. Returns array of { index, command, width, height }. */
export async function listPanes(ctx, name) {
  try {
    const { stdout } = await ctx.tmux(
      `list-panes -t '${esc(name)}' -F '#{pane_index}|#{pane_width}x#{pane_height}|#{pane_current_command}'`,
    );
    return stdout.trim().split("\n").map((line) => {
      const [index, size, command] = line.split("|");
      const [width, height] = size.split("x");
      return { index: parseInt(index), command, width: parseInt(width), height: parseInt(height) };
    });
  } catch {
    return [];
  }
}

/** Get status of a specific pane. */
export async function getPaneStatus(ctx, name, pane) {
  try {
    const { stdout } = await ctx.tmux(
      `capture-pane -t '${esc(name)}:.${pane}' -p -S -30`,
    );
    return detectPaneStatus(stripAnsi(stdout));
  } catch {
    return "unknown";
  }
}

/** Send keys to a pane. */
export async function sendKeys(ctx, name, pane, keys) {
  await ctx.tmux(`send-keys -t '${esc(name)}:.${pane}' ${keys}`);
}

/** Select a menu option (navigate with arrows + Enter). */
export async function selectOption(ctx, name, pane, choice) {
  const target = `${name}:.${pane}`;
  // Move to top first (20 ups), then down to choice
  for (let i = 0; i < 20; i++) {
    await ctx.tmux(`send-keys -t '${esc(target)}' Up`);
  }
  for (let i = 0; i < choice; i++) {
    await ctx.tmux(`send-keys -t '${esc(target)}' Down`);
  }
  await ctx.tmux(`send-keys -t '${esc(target)}' Enter`);
}
