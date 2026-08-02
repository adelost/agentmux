#!/usr/bin/env node
// agent. Node.js CLI for managing Claude Code tmux sessions.
// Replaces the bash agent script with shared agentmux code.

import { resolve, dirname } from "path";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { ensureConfig } from "../cli/config.mjs";
import { createTmuxContext } from "../cli/tmux.mjs";
import { dispatch } from "../cli/commands.mjs";
import { cmdRestarter } from "../cli/restarter.mjs";
import { cmdRestartReady } from "../cli/restart-ready.mjs";
import { resolveConfigSources } from "../core/config-sources.mjs";
import { parseEnv } from "../lib.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// BRIDGE_DIR = agentmux package root. agentmux.yaml (the user-editable
// source config) lives here. Tests may override via AGENTMUX_BRIDGE_DIR.
const BRIDGE_DIR = process.env.AGENTMUX_BRIDGE_DIR || resolve(__dir, "..");
const configSources = resolveConfigSources({ packageDir: BRIDGE_DIR });
try {
  const values = parseEnv(readFileSync(configSources.envFile.path, "utf8"));
  if (!process.env.STATE_FILE && values.STATE_FILE) process.env.STATE_FILE = values.STATE_FILE;
} catch { /* CLI commands without bridge secrets remain available. */ }

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
  const argv = process.argv.slice(2);
  if (argv[0] === "restarter") await cmdRestarter(argv.slice(1), ctx);
  else if (argv[0] === "restart-ready") await cmdRestartReady(argv.slice(1), ctx);
  else if (argv[0] === "emulator") await (await import("../cli/emulator.mjs")).cmdEmulator(argv.slice(1));
  else if (argv[0] === "work") await (await import("../cli/work.mjs")).cmdWork(argv.slice(1));
  else await dispatch(argv, ctx);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
