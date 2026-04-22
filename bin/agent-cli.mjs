#!/usr/bin/env node
// agent. Node.js CLI for managing Claude Code tmux sessions.
// Replaces the bash agent script with shared agentmux code.

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { ensureConfig } from "../cli/config.mjs";
import { createTmuxContext } from "../cli/tmux.mjs";
import { dispatch } from "../cli/commands.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// BRIDGE_DIR = agentmux package root. agentmux.yaml (the user-editable
// source config) lives here. Tests may override via AGENTMUX_BRIDGE_DIR.
const BRIDGE_DIR = process.env.AGENTMUX_BRIDGE_DIR || resolve(__dir, "..");

const SOCKET = process.env.TMUX_SOCKET || "/tmp/openclaw-claude.sock";
const CONFIG_PATH = process.env.AGENT_CONFIG || resolve(process.env.HOME, ".config/agent/agents.yaml");
const LAST_FILE = resolve(process.env.HOME, ".config/agent/.last");

ensureConfig(CONFIG_PATH);

const tmuxCtx = createTmuxContext(SOCKET, CONFIG_PATH);
const ctx = {
  ...tmuxCtx,
  configPath: CONFIG_PATH,
  lastFile: LAST_FILE,
  bridgeDir: BRIDGE_DIR,
};

try {
  await dispatch(process.argv.slice(2), ctx);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
