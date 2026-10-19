#!/usr/bin/env node
// WHAT: Claude Stop-hook entrypoint for one-pane reactive watcher pokes.
// WHY: Keeps hook wiring tiny while the tested resolver prevents global fanout.

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { cwdFromHookInput, loadAgentsConfig, resolvePaneFromCwd, sendReactivePoke } from "../core/reactive-poke.mjs";
import { runtimeAgentsPath } from "../core/runtime-defaults.mjs";
import { loadRuntimeEnv } from "../core/runtime-env.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dir, "..");

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
  // The CLI's sources and order: process env, ~/.agentmux/.env, then this package's .env.
  const env = loadRuntimeEnv({ packageRoot: root, processEnv: { ...process.env } });
  if (env.AMUX_REACTIVE_POKE !== "1") return;

  const agentsYaml = runtimeAgentsPath(env, env.HOME);
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
