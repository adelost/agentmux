#!/usr/bin/env node
// Relay for a coding agent on a computer the fleet cannot reach (row 211, Mattias 16 Nov): it long-polls one api.v1d.io mailbox, runs each
// message through Claude Code or Copilot CLI headless in one kept session, and writes the answer back. One file, Node 18+, no packages, so it
// copies to a work computer as it is. The device key reaches its one box and nothing else; the owner closes the box to take it back.
//
//   node agent-relay.mjs setup <box id> <device key> [--api URL]     once; saves ~/.config/agent-relay/config.json (mode 600)
//   node agent-relay.mjs run [--agent claude|copilot] [--dir PATH]   the loop; "/new" in a message starts a fresh session
//   node agent-relay.mjs send "text"                                 the agent (or you) writes to the phone
//   AGENT_RELAY_HOME=~/.config/agent-relay-copilot node agent-relay.mjs …   a second relay with its own box
//
// So the agent writes on its own when it is done or stuck, one line in its CLAUDE.md or .github/copilot-instructions.md:
//   When you finish a task, get stuck or need a decision, run: node <path>/agent-relay.mjs send "<one short line>"

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** AGENT_RELAY_HOME gives a second relay on the same computer (one for Claude, one for Copilot) its own box and session. */
const HOME = process.env.AGENT_RELAY_HOME || join(homedir(), ".config", "agent-relay");
const CONFIG = join(HOME, "config.json"), STATE = join(HOME, "state.json");
const DEFAULT_API = "https://api.v1d.io", WAIT_S = 50, RUN_LIMIT_MS = 30 * 60_000, TEXT_CHARS = 32_000;

/** WHAT: The headless command for one message. WHY: Both CLIs take a prompt and a session id; Claude starts a session with --session-id and
 *  continues it with --resume, Copilot does both with --session-id. Both may edit and run commands in the folder without asking, since no one
 *  is at the terminal to answer (Copilot runs no tool in prompt mode without --allow-all-tools). */
export function agentCommand(agent, text, session, started) {
  if (agent === "copilot") return ["copilot", ["-p", text, "-s", "--session-id", session, "--allow-all-tools"]];
  if (agent === "claude") return ["claude", ["-p", text, started ? "--resume" : "--session-id", session, "--permission-mode", "acceptEdits", "--allowedTools", "Bash"]];
  throw new Error(`unknown agent "${agent}": use claude or copilot`);
}

/** WHAT: Pairs this computer with a box. WHY: The key file is readable by its owner alone. */
function setup([box, deviceKey], api) {
  if (!/^mbx_[a-f0-9]{32}$/.test(box || "") || !/^v1dm\.[A-Za-z0-9_-]{43}$/.test(deviceKey || "")) fail("usage: setup <mbx_…> <v1dm.…>");
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG, JSON.stringify({ api, box, deviceKey }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(CONFIG, 0o600);
  console.log(`paired with ${box}; start with: node agent-relay.mjs run --agent claude`);
}

/** WHAT: The poll loop. WHY: One message at a time in one session, and the last number read is saved before the agent runs, so a restart
 *  never runs a message twice (it may skip the one that was running; its sender is told nothing came back and can send it again). */
async function run({ agent, dir }) {
  const config = readConfig(), state = readState();
  state.sessions ??= {};
  console.log(`relay: ${agent} in ${dir}, box ${config.box}`);
  await send(config, `relay up: ${agent} in ${dir}`);
  for (;;) {
    let letters;
    try { letters = await mailbox(config, "GET", `?after=${state.after ?? 0}&wait=${WAIT_S}`); }
    catch (error) { console.warn(`relay: poll failed, ${error.message}; retrying in 10 s`); await sleep(10_000); continue; }
    for (const letter of letters.data) {
      state.after = letter.seq; saveState(state);
      await answer(config, state, { agent, dir }, letter.text.trim());
    }
  }
}

async function answer(config, state, { agent, dir }, text) {
  const key = `${agent}:${dir}`;
  if (text === "/new") { delete state.sessions[key]; saveState(state); return send(config, "new session from the next message"); }
  const known = state.sessions[key], session = known?.id ?? randomUUID();
  state.sessions[key] = { id: session, started: Boolean(known) }; saveState(state);
  const [command, args] = agentCommand(agent, text, session, Boolean(known));
  const { code, out, err } = await runAgent(command, args, dir);
  state.sessions[key].started = true; saveState(state);
  const reply = code === 0 ? out.trim() || "(no answer text)" : `${command} exited ${code}: ${(err || out).trim().slice(-1500)}`;
  await send(config, reply);
}

/** WHAT: Runs the agent with no terminal attached. WHY: Its stdout is the answer; a run past 30 minutes is stopped and reported. No shell, so a
 *  message is never read as a command line; on Windows that needs the CLI's own .exe, not an npm .cmd shim. */
function runAgent(command, args, dir) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill("SIGTERM"), RUN_LIMIT_MS);
    child.on("error", (error) => { clearTimeout(timer); resolve({ code: -1, out, err: error.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? -1, out, err }); });
  });
}

/** WHAT: Writes to the owner, in parts when long. WHY: The box takes 32 000 characters a message. */
async function send(config, text) {
  for (let at = 0; at < text.length; at += TEXT_CHARS) await mailbox(config, "POST", "", { text: text.slice(at, at + TEXT_CHARS) });
}

async function mailbox(config, method, query, body) {
  const response = await fetch(`${config.api}/v1/mailboxes/${config.box}/messages${query}`, {
    method, headers: { Authorization: `Bearer ${config.deviceKey}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout((WAIT_S + 20) * 1000),
  });
  if (response.status === 404) fail("the box is closed or the key is wrong; pair again with setup");
  if (!response.ok) throw new Error(`api.v1d.io answered ${response.status}`);
  return response.json();
}

function readConfig() {
  if (!existsSync(CONFIG)) fail("not paired: run setup <box id> <device key> first");
  return JSON.parse(readFileSync(CONFIG, "utf8"));
}
const readState = () => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const saveState = (state) => writeFileSync(STATE, JSON.stringify(state) + "\n", { mode: 0o600 });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fail(message) { console.error(`relay: ${message}`); process.exit(1); }
const option = (args, name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("agent-relay.mjs")) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "setup") setup(args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--api"), option(args, "--api", DEFAULT_API));
  else if (command === "run") await run({ agent: option(args, "--agent", "claude"), dir: option(args, "--dir", process.cwd()) });
  else if (command === "send" && args.join(" ").trim()) await send(readConfig(), args.join(" "));
  else fail("usage: setup <box id> <device key> | run [--agent claude|copilot] [--dir PATH] | send \"text\"");
}
