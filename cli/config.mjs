// Config management for agent CLI. Replaces all bash yq calls.
// Single source of truth: ~/.config/agent/agents.yaml

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import yaml from "js-yaml";
import { expandTilde } from "../sync.mjs";

const CLAUDE_CMD = "claude --continue --dangerously-skip-permissions";

/** Ensure config file exists, create if missing. */
export function ensureConfig(configPath) {
  if (existsSync(configPath)) return;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, "# Agent configurations\n");
}

/** Load and parse agents.yaml. Returns {} if missing/empty. */
export function loadConfig(configPath) {
  try {
    return yaml.load(readFileSync(configPath, "utf-8")) || {};
  } catch {
    return {};
  }
}

/** Write config back to YAML. */
export function saveConfig(configPath, data) {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, yaml.dump(data, { lineWidth: -1, quotingType: '"' }));
}

/** Get agent config by name. Throws if not found. */
export function getAgent(configPath, name) {
  const config = loadConfig(configPath);
  const agent = config[name];
  if (!agent?.dir) throw new Error(`Agent '${name}' not found`);
  return { name, ...agent, dir: expandTilde(agent.dir) };
}

/** List all agents sorted by name. */
export function listAgents(configPath) {
  const config = loadConfig(configPath);
  return Object.entries(config)
    .filter(([, v]) => v?.dir)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, conf], i) => ({
      index: i + 1,
      name,
      dir: expandTilde(conf.dir),
      id: conf.id,
      panes: conf.panes || [],
      layout: conf.layout,
      discord: conf.discord,
    }));
}

/** Add a new agent with default claude pane. */
export function addAgent(configPath, name, dir) {
  const config = loadConfig(configPath);
  if (config[name]) throw new Error(`Agent '${name}' already exists`);
  config[name] = {
    dir,
    id: randomUUID(),
    panes: [{ name: "claude", cmd: CLAUDE_CMD }],
  };
  saveConfig(configPath, config);
  return config[name];
}

/** Remove an agent from config. */
export function removeAgent(configPath, name) {
  const config = loadConfig(configPath);
  if (!config[name]) throw new Error(`Agent '${name}' not found`);
  delete config[name];
  saveConfig(configPath, config);
}

/** Resolve :N index syntax or passthrough plain name. */
export function resolveAgent(arg, configPath) {
  const indexMatch = arg.match(/^:(\d+)$/);
  if (indexMatch) {
    const agents = listAgents(configPath);
    const idx = parseInt(indexMatch[1]) - 1;
    if (idx < 0 || idx >= agents.length) throw new Error(`No agent at index ${indexMatch[1]}`);
    return agents[idx].name;
  }
  return arg;
}

/** Get pane command for a specific pane index. */
export function getPaneCmd(configPath, name, idx) {
  const config = loadConfig(configPath);
  return config[name]?.panes?.[idx]?.cmd || "bash";
}

/** Check if a pane is deferred. */
export function isDeferred(configPath, name, idx) {
  const config = loadConfig(configPath);
  return config[name]?.panes?.[idx]?.defer === true;
}

/** Get tmux layout for an agent. */
export function getLayout(configPath, name) {
  const config = loadConfig(configPath);
  return config[name]?.layout || "main-vertical";
}

/** Get pane count for an agent. */
export function getPaneCount(configPath, name) {
  const config = loadConfig(configPath);
  return config[name]?.panes?.length || 0;
}

/** Save last-used agent name for resume. */
export function saveLast(lastFile, name) {
  mkdirSync(dirname(lastFile), { recursive: true });
  writeFileSync(lastFile, name);
}

/** Get last-used agent name. */
export function getLast(lastFile) {
  try { return readFileSync(lastFile, "utf-8").trim(); } catch { return null; }
}
