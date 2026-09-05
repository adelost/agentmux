#!/usr/bin/env node
// agent. Node.js CLI for managing Claude Code tmux sessions.
// Replaces the bash agent script with shared agentmux code.

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "node:fs";
import { ensureConfig } from "../cli/config.mjs";
import { createTmuxContext } from "../cli/tmux.mjs";
import { DEFAULT_TMUX_SOCKET } from "../core/runtime-defaults.mjs";
import { runtimeAgentsPath } from "../core/runtime-defaults.mjs";
import { loadRuntimeEnv } from "../core/runtime-env.mjs";
import { resolveConfigSources } from "../core/config-sources.mjs";
import { ensureRuntimeConfig } from "../core/runtime-config.mjs";
import { isDispatchHelp } from "../cli/command-args.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
// BRIDGE_DIR = agentmux package root. agentmux.yaml (the user-editable
// source config) lives here. Tests may override via AGENTMUX_BRIDGE_DIR.
const BRIDGE_DIR = process.env.AGENTMUX_BRIDGE_DIR || resolve(__dir, "..");
loadRuntimeEnv({ packageRoot: BRIDGE_DIR });

const SOCKET = process.env.TMUX_SOCKET || DEFAULT_TMUX_SOCKET;
const configSources = resolveConfigSources({ packageDir: BRIDGE_DIR });
const CONFIG_PATH = runtimeAgentsPath();
const LAST_FILE = resolve(process.env.HOME, ".config/agent/.last");
const argv = process.argv.slice(2);
const helpOnly = isDispatchHelp(argv);

// Syntax probes must also bypass config generation, not only the final handler.
if (!helpOnly) {
  if (existsSync(configSources.agentmuxYaml.path) || existsSync(CONFIG_PATH)) {
    ensureRuntimeConfig({
      sourcePath: configSources.agentmuxYaml.path,
      generatedPath: CONFIG_PATH,
    });
  }
  ensureConfig(CONFIG_PATH);
}

const tmuxCtx = helpOnly ? {} : createTmuxContext(SOCKET, CONFIG_PATH);
const ctx = {
  ...tmuxCtx,
  configPath: CONFIG_PATH,
  lastFile: LAST_FILE,
  bridgeDir: BRIDGE_DIR,
  sourceConfigPath: configSources.agentmuxYaml.path,
};

try {
  // Runtime config must exist before the command graph is evaluated: several
  // command modules intentionally snapshot environment-backed defaults.
  if (argv[0] === "restarter") {
    await (await import("../cli/restarter.mjs")).cmdRestarter(argv.slice(1), ctx);
  }
  else if (argv[0] === "restart-ready") {
    await (await import("../cli/restart-ready.mjs")).cmdRestartReady(argv.slice(1), ctx);
  }
  else if (argv[0] === "emulator") await (await import("../cli/emulator.mjs")).cmdEmulator(argv.slice(1));
  else if (argv[0] === "work") await (await import("../cli/work.mjs")).cmdWork(argv.slice(1));
  else await (await import("../cli/commands.mjs")).dispatch(argv, ctx);
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
