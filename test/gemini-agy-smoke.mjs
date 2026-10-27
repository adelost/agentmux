// One live agy turn on the operator's own login in an isolated tmux server: start, receipt, screen answer, mirror, exact resume.
// Spends one subscription request. It never reads agy's credential files and never touches a configured pane.
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import yaml from "js-yaml";
import { createTmuxAdapter } from "../core/tmux.mjs";
import { createGeminiRuntime } from "../core/gemini-runtime.mjs";
import { captureGeminiPromptCursor, geminiPromptAccepted } from "../core/gemini-prompt-echo.mjs";
import { createGeminiTmuxMirror } from "../core/gemini-tmux-mirror.mjs";
import { createAgent } from "../agent.mjs";
import { createState } from "../core/state.mjs";

const root = mkdtempSync(join(tmpdir(), "amux-agy-smoke-"));
const cwd = join(root, "repo");
const exec = promisify(execCb), socket = join(root, "tmux.sock");
const tmuxExec = command => exec(command.replace("tmux -S", "tmux -f /dev/null -S"), { timeout: 5000 });
const t = createTmuxAdapter({ socket, exec: tmuxExec });
const name = "agy-proof", target = `${name}:.0`;
const state = createState(join(root, "state.json"));
const config = { [name]: { dir: cwd, panes: [{ engine: "gemini", cmd: "agy --dangerously-skip-permissions" }] } };
const configPath = join(root, "agents.yaml"); writeFileSync(configPath, yaml.dump(config));
const wait = ms => new Promise(done => setTimeout(done, ms));
const agent = createAgent({ tmuxSocket: socket, configPath, tmuxExec, state, run: exec, delay: wait });
const runtime = createGeminiRuntime({ t, state, wait, paneDir: () => cwd, agentConfig: () => config[name],
  isAlreadyRunning: async () => false, isPaneDead: async () => false, respawnPane: async () => {},
  captureScreen: () => t.captureScreen(target), assertEngineStartAllowed: async () => {},
  executable: process.argv[2] || join(homedir(), ".local", "bin", "agy") });
const prompt = ["AMUX_AGY_SMOKE: run the shell command `echo AGY_TOOL_OK`,", "then answer with exactly one line: AGY_SMOKE_OK"].join("\n");
const start = performance.now();
try {
  await exec(`mkdir -p '${cwd}'`);
  await t.raw(`new-session -d -s ${name} -x 140 -y 45 /bin/bash`);
  const first = await runtime.startGemini(name, target, cwd, 0);
  const cursor = captureGeminiPromptCursor(prompt, { dir: cwd });
  writeFileSync(join(root, "prompt.txt"), prompt);
  await t.loadBuffer("agy_smoke", join(root, "prompt.txt")); await t.pasteBuffer("agy_smoke", target);
  await wait(500); await t.sendEnter(target);
  const deadline = performance.now() + 90_000;
  let accepted = false, reply, busy = true;
  while (performance.now() < deadline) {
    accepted ||= geminiPromptAccepted(prompt, { cursor, dir: cwd });
    reply = await agent.getResponseStreamWithRaw(name, 0, prompt);
    busy = await agent.isBusy(name, 0);
    if (accepted && !busy && reply.items.some(item => item.content === "AGY_SMOKE_OK")) break;
    await wait(500);
  }
  writeFileSync(join(root, "screen.txt"), await t.captureScreen(target));
  if (!accepted || busy || !reply?.items.some(item => item.content === "AGY_SMOKE_OK")) throw new Error("receipt or screen answer missing");
  const posts = [];
  const mirror = createGeminiTmuxMirror({ agent, state, post: async value => { posts.push(value); return { ok: true }; } });
  await mirror.poll({ name, idx: 0, channelId: "fake-channel", dir: cwd });
  await mirror.poll({ name, idx: 0, channelId: "fake-channel", dir: cwd });
  if (posts.length !== 1) throw new Error(`expected one mirrored reply, got ${posts.length}`);
  await t.sendKeys(target, "C-c"); await wait(300); await t.sendKeys(target, "C-c"); await wait(1500);
  const resumed = await runtime.startGemini(name, target, cwd, 0);
  const screen = await t.capture(target, { lines: 200 });
  if (!resumed.sessionId || !screen.includes(`--conversation '${resumed.sessionId}'`) || !screen.includes("AMUX_AGY_SMOKE")) {
    throw new Error("restart did not resume the exact conversation");
  }
  console.log(JSON.stringify({ ok: true, root, elapsedMs: Math.round(performance.now() - start), firstSession: first.sessionId,
    resumedSession: resumed.sessionId, accepted, items: reply.items.map(item => item.type),
    mirrored: posts[0].turn.items.filter(item => item.type === "text").map(item => item.content) }));
} catch (error) {
  writeFileSync(join(root, "failure-screen.txt"), await t.capture(target, { lines: 200 }).catch(() => ""));
  console.error(JSON.stringify({ ok: false, root, error: error.message })); process.exitCode = 1;
} finally { await t.killSession(name).catch(() => {}); }
