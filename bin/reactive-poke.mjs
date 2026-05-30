#!/usr/bin/env node
// WHAT: Claude Stop-hook entrypoint for one-pane reactive watcher pokes.
// WHY: Keeps hook wiring tiny while the tested resolver prevents global fanout.

import { existsSync, readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { cwdFromHookInput, loadAgentsConfig, resolvePaneFromCwd, sendReactivePoke } from "../core/reactive-poke.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const raw of readFileSync(path, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    value = value.replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

async function readHookInput() {
  if (process.stdin.isTTY) return {};
  let input = "";
  const timeout = setTimeout(() => process.exit(0), 500);
  process.stdin.setEncoding("utf-8");
  for await (const chunk of process.stdin) input += chunk;
  clearTimeout(timeout);
  if (!input.trim()) return {};
  try { return JSON.parse(input); }
  catch { return {}; }
}

async function main() {
  const env = { ...parseEnvFile(resolve(root, ".env")), ...process.env };
  if (env.AMUX_REACTIVE_POKE !== "1") return;

  const agentsYaml = env.AGENTS_YAML || resolve(root, "agents.yaml");
  const port = Number(env.VOICE_PWA_PORT || 8080);
  const hookInput = await readHookInput();
  const cwd = cwdFromHookInput(hookInput, process.cwd());
  const config = loadAgentsConfig(agentsYaml);
  const target = resolvePaneFromCwd(cwd, config);
  if (!target) return;

  const result = await sendReactivePoke({ port, name: target.name, pane: target.pane });
  if (env.AMUX_REACTIVE_POKE_LOG === "1") {
    const status = result.ok ? "ok" : `skip ${result.statusCode || result.error || "unknown"}`;
    console.error(`amux reactive-poke ${target.name}:${target.pane} ${status}`);
  }
}

main().catch(() => {});
