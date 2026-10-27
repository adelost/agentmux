// Named feasibility probe. Never touches the shared tmux socket, config or Google login.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { exec as execCb, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createTmuxAdapter } from "../core/tmux.mjs";
import { buildGeminiLaunchCommand, assertGeminiStartPolicy, GEMINI_FORBIDDEN_ENV } from "../core/gemini-launch.mjs";
import { esc } from "../lib.mjs";

const exec = promisify(execCb);
const root = mkdtempSync(join(tmpdir(), "amux-gemini-fake-"));
const profileHome = join(root, "home");
const cwd = join(root, "repo");
const sessionId = "71333413-1234-4234-8234-123456789abc";
const generation = "probe";
const eventsPath = join(root, `events-${generation}.jsonl`);
const hook = fileURLToPath(new URL("../bin/gemini-hook.mjs", import.meta.url));
const blockNetwork = fileURLToPath(new URL("fixtures/gemini-no-network.cjs", import.meta.url));
const executable = process.argv[2] || "/home/adelost/.nvm/versions/node/v22.19.0/bin/gemini";
const envControl = process.argv.includes("--env-control");
const env = {
  PATH: process.env.PATH, HOME: profileHome, TERM: "xterm-256color", LANG: "C.UTF-8",
  GEMINI_CLI_HOME: profileHome, GEMINI_CLI_NO_RELAUNCH: "1", NO_AUTO_UPDATE: "1",
  NODE_OPTIONS: `--require=${blockNetwork}`, AMUX_GEMINI_EVENTS: eventsPath,
  AMUX_GEMINI_SESSION_ID: sessionId, AMUX_GEMINI_GENERATION: generation, AMUX_GEMINI_CWD: cwd,
  DISPLAY: "amux-fake-display-only", BROWSER: "/bin/false",
};
mkdirSync(join(profileHome, ".gemini"), { recursive: true });
mkdirSync(cwd);
writeFileSync(eventsPath, "");
const hookCommand = `'${esc(process.execPath)}' '${esc(hook)}'`;
const settings = {
  security: { auth: { selectedType: "oauth-personal", enforcedType: "oauth-personal" } },
  general: { enableAutoUpdate: false, enableAutoUpdateNotification: false },
  ui: { theme: "Default", showTips: false }, telemetry: { enabled: false },
  advanced: { autoConfigureMemory: false, ignoreLocalEnv: !envControl },
  hooks: Object.fromEntries(["SessionStart", "BeforeAgent", "AfterAgent", "SessionEnd"].map(name =>
    [name, [{ hooks: [{ name: `amux-${name}`, type: "command", command: hookCommand }] }]])),
};
// The negative control tests upstream dotenv behavior, not an admitted AMUX launch.
if (!envControl) assertGeminiStartPolicy({ profileHome, settings, env });
writeFileSync(join(profileHome, ".gemini", "settings.json"), JSON.stringify(settings));
writeFileSync(join(root, ".env"), "GOOGLE_API_KEY=synthetic-not-a-real-key\n");
const responses = join(root, "responses.jsonl");
const content = text => ({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2, totalTokenCount: 12 } });
writeFileSync(responses, [
  ...Array.from({ length: 30 }, () => ({ method: "countTokens", response: { totalTokens: 10 } })),
  ...Array.from({ length: 30 }, () => ({ method: "generateContent", response: content("{}") })),
  { method: "generateContentStream", response: [content("GEMINI_FAKE_FIRST_OK")] },
].map(JSON.stringify).join("\n") + "\n");
const t = createTmuxAdapter({ socket: join(root, "tmux.sock"),
  exec: command => exec(command.replace("tmux -S", "tmux -f /dev/null -S"), { env, timeout: 5000 }) });
const target = "gemini-proof:.0";
const start = performance.now();
let screen = "";
const readEvents = () => readFileSync(eventsPath, "utf8").split("\n").filter(Boolean).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
try {
  // A headless-display branch asks for Google auth even with a fake generator.
  // This fixture makes that branch false without opening a browser or changing production policy.
  const coreBundle = "/home/adelost/.nvm/versions/node/v22.19.0/lib/node_modules/@google/gemini-cli/bundle/chunk-DKZARV6U.js";
  const preflight = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const {shouldAttemptBrowserLaunch} = await import(${JSON.stringify(coreBundle)});` +
    `if (!shouldAttemptBrowserLaunch()) process.exit(1); delete process.env.DISPLAY;` +
    `if (shouldAttemptBrowserLaunch()) process.exit(2); console.log('PASS fake-auth-display-boundary 2/2');`],
  { env, encoding: "utf8", timeout: 10_000 });
  console.log(preflight.trim());
  const themePreflight = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const {themeManager} = await import('/home/adelost/.nvm/versions/node/v22.19.0/lib/node_modules/@google/gemini-cli/bundle/chunk-YTHYCFAB.js');` +
    `if (!themeManager.findThemeByName(${JSON.stringify(settings.ui.theme)})) process.exit(1); console.log('PASS fake-theme-boundary 1/1');`],
  { env, encoding: "utf8", timeout: 10_000 });
  console.log(themePreflight.trim());
  if (process.argv.includes("--preflight")) {
    console.log(JSON.stringify({ ok: true, root, scope: "auth-display-branch-only" }));
    process.exit(0);
  }
  await t.raw("new-session -d -s gemini-proof -x 120 -y 40 /bin/sh");
  const command = buildGeminiLaunchCommand({ executable, profileHome, sessionId, allowFreshBootstrap: true });
  await t.sendLiteral(target, `cd '${esc(cwd)}' && ${command} --fake-responses-non-strict '${esc(responses)}'`);
  await t.sendEnter(target);
  const deadline = performance.now() + 30_000;
  while (performance.now() < deadline) {
    screen = await t.captureScreen(target);
    if (/Type your message|What would you like to do|How can I help/u.test(screen)
        && readEvents().some(event => event.hook_event_name === "SessionStart")) break;
    if (performance.now() - start > 1500 && await t.currentCommand(target) === "sh") break;
    await new Promise(done => setTimeout(done, 250));
  }
  writeFileSync(join(root, "ready-screen.txt"), screen);
  if (!/Type your message|What would you like to do|How can I help/u.test(screen)) {
    throw new Error("fake TUI did not reach its composer in 30s");
  }
  const startReceipt = readEvents()
    .find(event => event.hook_event_name === "SessionStart");
  if (!startReceipt || !GEMINI_FORBIDDEN_ENV.every(name =>
    startReceipt.environment?.[name] === (envControl && name === "GOOGLE_API_KEY"))) {
    throw new Error("effective environment does not match the named synthetic dotenv case");
  }
  if (process.argv.includes("--environment-only") || envControl) {
    console.log(JSON.stringify({ ok: true, root, scope: "synthetic-ancestor-dotenv",
      ignoreLocalEnv: !envControl, effectiveGoogleApiKey: startReceipt.environment.GOOGLE_API_KEY,
      elapsedMs: Math.round(performance.now() - start) }));
  } else if (process.argv.includes("--composer-only")) {
    console.log(JSON.stringify({ ok: true, root, scope: "composer-and-SessionStart-only", elapsedMs: Math.round(performance.now() - start) }));
  } else {
  await t.sendLiteral(target, "AMUX_GEMINI_FAKE_FIRST");
  // Same short-prompt settling interval as agent.mjs's ordinary TUI transport.
  await new Promise(done => setTimeout(done, 1000));
  await t.sendEnter(target);
  const answerDeadline = performance.now() + 15_000;
  while (performance.now() < answerDeadline) {
    screen = await t.captureScreen(target);
    if (screen.includes("GEMINI_FAKE_FIRST_OK")) break;
    await new Promise(done => setTimeout(done, 250));
  }
  writeFileSync(join(root, "answer-screen.txt"), screen);
  const events = readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const hooks = events.map(event => event.hook_event_name);
  if (!screen.includes("GEMINI_FAKE_FIRST_OK") || !hooks.includes("BeforeAgent") || !hooks.includes("AfterAgent")) {
    throw new Error(`fake answer/hooks missing; hooks=${hooks.join(",")}`);
  }
  console.log(JSON.stringify({ ok: true, root, elapsedMs: Math.round(performance.now() - start), hooks }));
  }
} catch (error) {
  writeFileSync(join(root, "failure-screen.txt"), await t.capture(target, { lines: 150 }).catch(() => screen));
  console.error(JSON.stringify({ ok: false, root, error: error.message, elapsedMs: Math.round(performance.now() - start) }));
  process.exitCode = 1;
} finally {
  await t.killSession("gemini-proof").catch(() => {});
}
