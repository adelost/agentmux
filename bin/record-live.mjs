#!/usr/bin/env node
// record-live: send a prompt to a real agent/pane, wait for idle, capture + save recording.
// Lets us trigger extract pipeline tests without going through Discord.
//
// Usage:
//   node bin/record-live.mjs <agent> <pane> "prompt text"
//   node bin/record-live.mjs claw 0 "what is 2+2?"
//   node bin/record-live.mjs claw 1 "read handlers.mjs and summarize"

import { exec as execCb } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { parseEnv } from "../lib.mjs";
import { createAgent } from "../agent.mjs";
import { createRecorder } from "../core/recorder.mjs";
import { load as loadYaml } from "js-yaml";

const __dir = dirname(fileURLToPath(import.meta.url));

// --- Args ---

const [, , agentName, paneArg, ...promptParts] = process.argv;
const pane = parseInt(paneArg ?? "0", 10);
const prompt = promptParts.join(" ").trim();

if (!agentName || Number.isNaN(pane) || !prompt) {
  console.error("usage: node bin/record-live.mjs <agent> <pane> \"prompt\"");
  process.exit(1);
}

// --- Env ---

function loadEnv() {
  try {
    const vars = parseEnv(readFileSync(resolve(__dir, "..", ".env"), "utf-8"));
    for (const [k, v] of Object.entries(vars)) if (!process.env[k]) process.env[k] = v;
  } catch {}
}
loadEnv();

const AGENTS_YAML = process.env.AGENTS_YAML || resolve(__dir, "..", "agents.yaml");
const TMUX_SOCKET = process.env.TMUX_SOCKET || "/tmp/openclaw-claude.sock";
const TIMEOUT = parseInt(process.env.TIMEOUT_S || "600") * 1000;
const SHELL_PATH = process.env.SHELL_PATH || `${process.env.HOME}/bin:${process.env.PATH}`;

const exec = promisify(execCb);
const run = (cmd, timeoutMs = TIMEOUT) =>
  exec(cmd, { timeout: timeoutMs, env: { ...process.env, PATH: SHELL_PATH }, maxBuffer: 1024 * 1024 });
const tmuxExec = (cmd) =>
  exec(cmd, { timeout: 3000, env: { ...process.env, PATH: SHELL_PATH } });

const agent = createAgent({ tmuxSocket: TMUX_SOCKET, configPath: AGENTS_YAML, timeout: TIMEOUT, run, tmuxExec });

const recordingsDir = resolve(__dir, "..", "test/recordings");
const recorder = createRecorder({ dir: recordingsDir });

// --- Agent config (for dir lookup) ---

function loadAgentDir(name) {
  const config = loadYaml(readFileSync(AGENTS_YAML, "utf-8")) || {};
  const entry = config[name];
  if (!entry?.dir) throw new Error(`agent '${name}' not found in ${AGENTS_YAML}`);
  return entry.dir;
}

// --- Run ---

async function main() {
  const agentDir = loadAgentDir(agentName);
  console.log(`→ ${agentName}:${pane} "${prompt.slice(0, 80)}${prompt.length > 80 ? "…" : ""}"`);

  await agent.sendOnly(agentName, prompt, pane);
  const startTime = Date.now();

  // Step 1: Wait for the prompt to be echoed back in the pane — positive
  // confirmation that the agent received the input.
  const echoed = await agent.waitForPromptEcho(agentName, pane, prompt, 15_000);
  if (!echoed) {
    console.error(`\nERROR: prompt not echoed within 15s. Pane may be dead.`);
    process.exit(1);
  }

  // Step 2: Wait for completion (idle 2 polls in a row after we saw busy)
  const maxDuration = 10 * 60 * 1000;
  let sawWorking = false;
  let idleStreak = 0;
  const pollMs = 2000;
  const workMaxMs = 60_000;

  while (Date.now() - startTime < maxDuration) {
    const busy = await agent.isBusy(agentName, pane);
    if (busy) {
      if (!sawWorking) process.stdout.write("working");
      else process.stdout.write(".");
      sawWorking = true;
      idleStreak = 0;
    } else {
      idleStreak += 1;
      if (sawWorking && idleStreak >= 2) break;
    }
    if (!sawWorking && Date.now() - startTime > workMaxMs) {
      process.stdout.write("\n!! Agent echoed prompt but never went busy within 60s — extracting anyway\n");
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  if (sawWorking) process.stdout.write("\n");

  await agent.dismissBlockingPrompt(`${agentName}:.${pane}`).catch(() => {});

  const { raw, turn, items } = await agent.getResponseStreamWithRaw(agentName, pane, prompt);
  const context = agent.getContextPercent(agentDir, pane);

  const discordSent = [];
  for (const item of items) {
    discordSent.push(item.type === "tool" ? `*${item.content}*` : item.content);
  }
  if (context) {
    const k = Math.round(context.tokens / 1000);
    discordSent.push(`_context: ${context.percent}% (${k}k)_`);
  }

  recorder.save({
    ts: new Date().toISOString(),
    agent: agentName,
    pane,
    prompt,
    raw,
    turn,
    items,
    context,
    discordSent,
    durationMs: Date.now() - startTime,
    source: "record-live",
  });

  console.log(`\n--- Recording saved to ${recordingsDir} ---`);
  console.log(`items: ${items.length}, duration: ${Math.round((Date.now() - startTime) / 1000)}s`);
  if (items.length === 0) {
    console.log("\n!! WARNING: no items extracted. Check recording JSON for raw/turn.");
  } else {
    console.log("");
    for (const item of items) {
      const preview = item.content.length > 100 ? item.content.slice(0, 100) + "…" : item.content;
      console.log(`  [${item.type}] ${preview}`);
    }
  }
  if (context) console.log(`\ncontext: ${context.percent}% (${Math.round(context.tokens / 1000)}k)`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(`ERROR: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
