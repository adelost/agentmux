// One isolated installed-CLI fake turn. No live panel, login files, hooks or provider calls.
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import yaml from "js-yaml";
import { createTmuxAdapter } from "../core/tmux.mjs";
import { createGeminiRuntime } from "../core/gemini-runtime.mjs";
import { captureGeminiPromptCursor, geminiPromptAccepted } from "../core/gemini-prompt-echo.mjs";
import { createGeminiTmuxMirror } from "../core/gemini-tmux-mirror.mjs";
import { createAgent } from "../agent.mjs";
import { createState } from "../core/state.mjs";

const root = mkdtempSync(join(tmpdir(), "amux-gemini-minimal-"));
const home = join(root, "home"), cwd = join(root, "repo with spaces");
mkdirSync(join(home, ".gemini"), { recursive: true }); mkdirSync(cwd);
const settings = { security: { auth: { selectedType: "oauth-personal" } },
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false }, ui: { theme: "Default" }, telemetry: { enabled: false },
  advanced: { autoConfigureMemory: false, ignoreLocalEnv: true } };
writeFileSync(join(home, ".gemini", "settings.json"), JSON.stringify(settings));
const responseFile = join(root, "fake-responses.jsonl");
const response = text => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } });
writeFileSync(responseFile, [
  ...Array.from({ length: 30 }, () => ({ method: "countTokens", response: { totalTokens: 10 } })),
  ...Array.from({ length: 30 }, () => ({ method: "generateContent", response: response("{}") })),
  { method: "generateContentStream", response: [response("GEMINI_MINIMAL_OK")] },
].map(JSON.stringify).join("\n") + "\n");
const fixture = path => fileURLToPath(new URL(path, import.meta.url));
const env = { PATH: process.env.PATH, HOME: home, TERM: "xterm-256color", LANG: "C.UTF-8",
  DISPLAY: "amux-fake-display-only", BROWSER: "/bin/false", GEMINI_CLI_NO_RELAUNCH: "1",
  NODE_OPTIONS: `--require=${fixture("fixtures/gemini-no-network.cjs")}`,
  AMUX_GEMINI_REAL_CLI: process.argv[2] || "/home/adelost/.nvm/versions/node/v22.19.0/bin/gemini",
  AMUX_GEMINI_FAKE_RESPONSES: responseFile };
const exec = promisify(execCb), socket = join(root, "tmux.sock");
const tmuxExec = command => exec(command.replace("tmux -S", "tmux -f /dev/null -S"), { env, timeout: 5000 });
const t = createTmuxAdapter({ socket, exec: tmuxExec });
const name = "gemini-proof", target = `${name}:.0`;
const state = createState(join(root, "state.json"));
const config = { [name]: { dir: cwd, panes: [{ engine: "gemini", cmd: "gemini --yolo --skip-trust" }] } };
const configPath = join(root, "agents.yaml"); writeFileSync(configPath, yaml.dump(config));
const wait = ms => new Promise(done => setTimeout(done, ms));
// Only this proof process sees the fixture's normal home. No GEMINI_CLI_HOME is used.
process.env.HOME = home;
const agent = createAgent({ tmuxSocket: socket, configPath, tmuxExec, state, run: exec, delay: wait });
const runtime = createGeminiRuntime({ t, state, wait, paneDir: () => cwd, agentConfig: () => config[name],
  isAlreadyRunning: async () => false, isPaneDead: async () => false, respawnPane: async () => {},
  captureScreen: () => t.captureScreen(target), assertEngineStartAllowed: async () => {},
  executable: fixture("fixtures/gemini-fake-cli.mjs") });
const start = performance.now();
try {
  await t.raw(`new-session -d -s ${name} -x 120 -y 40 /bin/sh`);
  const launch = await runtime.startGemini(name, target, cwd, 0);
  const prompt = "AMUX_GEMINI_MINIMAL_SCREEN_PROOF";
  const options = { home, sessionId: launch.sessionId };
  const cursor = captureGeminiPromptCursor(prompt, options);
  await t.sendLiteral(target, prompt); await wait(1000); await t.sendEnter(target);
  const deadline = performance.now() + 15_000;
  let accepted = false, reply;
  while (performance.now() < deadline) {
    accepted = geminiPromptAccepted(prompt, { ...options, cursor });
    reply = await agent.getResponseStreamWithRaw(name, 0, prompt);
    if (accepted && reply.items.some(item => item.content === "GEMINI_MINIMAL_OK") && !await agent.isBusy(name, 0)) break;
    await wait(250);
  }
  writeFileSync(join(root, "screen.txt"), await t.captureScreen(target));
  if (!accepted || !reply?.items.some(item => item.content === "GEMINI_MINIMAL_OK")) throw new Error("fake prompt receipt or screen answer missing");
  const posts = [];
  const mirror = createGeminiTmuxMirror({ agent, state, home, post: async value => { posts.push(value); return { ok: true }; } });
  await mirror.poll({ name, idx: 0, channelId: "fake-channel", sessionId: launch.sessionId });
  await mirror.poll({ name, idx: 0, channelId: "fake-channel", sessionId: launch.sessionId });
  if (posts.length !== 1) throw new Error(`expected one captured mirror, got ${posts.length}`);
  console.log(JSON.stringify({ ok: true, root, elapsedMs: Math.round(performance.now() - start), accepted,
    source: reply.source, answer: posts[0].turn.items.filter(item => item.type === "text").map(item => item.content).join("\n"), modelCalls: 0 }));
} catch (error) {
  writeFileSync(join(root, "failure-screen.txt"), await t.capture(target, { lines: 120 }).catch(() => ""));
  console.error(JSON.stringify({ ok: false, root, error: error.message })); process.exitCode = 1;
} finally { await t.killSession(name).catch(() => {}); }
