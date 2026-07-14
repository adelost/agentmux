#!/usr/bin/env node

// Destructive-isolation canary for the native bridge backend. It deliberately
// uses a new target name, loopback port, registry and workspace so proving the
// replacement path can never create or stop a legacy fleet pane.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import yaml from "js-yaml";
import { createDeliveryBroker } from "../../../core/delivery-broker.mjs";
import { createDeliveryQueue } from "../../../core/delivery-queue.mjs";
import { createNativeRuntimeClient } from "../../../core/native-runtime-client.mjs";
import {
  createNativeRuntimeWatcher,
  groupNativeTurns,
} from "../../../channels/native-runtime-watcher.mjs";
import {
  nativeRuntimeStatus,
  startNativeRuntime,
  stopNativeRuntime,
} from "../../../cli/native-runtime-service.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const TARGET = "skybar-canary";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function argsOf(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`unknown argument '${key}'`);
    const name = key.slice(2);
    if (["keep-running"].includes(name)) options[name] = true;
    else options[name] = argv[++index];
  }
  return options;
}

async function waitFor(read, predicate, label, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await read();
    if (predicate(latest)) return latest;
    await sleep(250);
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms`);
}

function assertNoCanaryTmux() {
  const result = spawnSync("tmux", ["has-session", "-t", TARGET], { stdio: "ignore" });
  assert.notEqual(result.status, 0, `${TARGET} unexpectedly exists as a tmux session`);
}

const options = argsOf(process.argv.slice(2));
const port = Number(options.port ?? 8812);
assert(Number.isSafeInteger(port) && port > 0 && port < 65_536, "--port must be a TCP port");
assert.notEqual(port, 8811, "the canary refuses the default/production native port 8811");
const canaryRoot = resolve(options.root ?? join(homedir(), ".agentmux", "canaries", "skybar-native"));
const dataDir = resolve(options["data-dir"] ?? join(canaryRoot, "data"));
const stateDir = resolve(options["state-dir"] ?? join(canaryRoot, "runtime"));
const workspace = resolve(options.workspace ?? join(canaryRoot, "workspace"));
const timeoutMs = Number(options.timeout ?? 180_000);
const runtimeUrl = `http://127.0.0.1:${port}`;
const runId = `${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${randomUUID().slice(0, 8)}`;
const serverPath = join(ROOT, "spikes", "web-ui", "server.mjs");

mkdirSync(workspace, { recursive: true, mode: 0o700 });
writeFileSync(join(workspace, "AGENTS.md"), [
  "# Native bridge canary",
  "",
  "This directory is an isolated transport canary. Do not edit files or access other projects.",
  "Only execute a command when the prompt explicitly asks for the interrupt probe.",
  "",
].join("\n"), { mode: 0o600 });
writeFileSync(join(workspace, "CLAUDE.md"), [
  "# Native bridge canary",
  "",
  "Do not edit files or access other projects. Follow the exact response requested by each probe.",
  "",
].join("\n"), { mode: 0o600 });
const attachmentPath = join(workspace, "transport-proof.txt");
writeFileSync(attachmentPath, `native attachment ${runId}\n`, { mode: 0o600 });

assertNoCanaryTmux();
let runtime = await nativeRuntimeStatus({ port, stateDir, dataDir });
if (!runtime.online) {
  runtime = await startNativeRuntime({ port, stateDir, dataDir, serverPath });
}
assert(runtime.online, "native runtime did not become healthy");
assert(runtime.managed, "canary runtime must be owned by its isolated service manager");
const firstBootId = runtime.health.bootId;

const config = {
  [TARGET]: {
    id: "src-0028-skybar-native-canary",
    dir: workspace,
    backend: "native",
    runtimeUrl,
    discord: {
      "native-canary-claude": 0,
      "native-canary-codex": 1,
    },
    panes: [
      { cmd: "native:claude", engine: "claude", effort: "medium" },
      { cmd: "native:codex", engine: "codex", effort: "medium" },
    ],
  },
};
const cliConfigPath = join(canaryRoot, "agents.yaml");
writeFileSync(cliConfigPath, yaml.dump(config), { mode: 0o600 });
const makeClient = () => createNativeRuntimeClient({
  configPath: "native-canary-in-memory",
  loadConfigImpl: () => config,
  timeoutMs: 15_000,
});
let client = makeClient();
const queue = createDeliveryQueue({ rootDir: join(canaryRoot, "queue", runId) });
let broker = createDeliveryBroker({ agent: client, queue, notify: async () => {} });

async function send(pane, phase, text, kind = "prompt") {
  const job = queue.enqueue({
    agentName: TARGET,
    pane,
    text,
    kind,
    source: "native-canary-gate",
    idempotencyKey: `${runId}:${pane}:${phase}`,
  });
  await broker.kickTarget(TARGET, pane);
  const stored = queue.read(TARGET, pane, job.id);
  assert.equal(stored.status, "acknowledged", `${phase} was not durably acknowledged: ${stored.lastReason}`);
  return job;
}

async function completedTurn(pane, job, marker) {
  const operationKey = `delivery:${job.id}`;
  const snapshot = await waitFor(
    () => client.history(TARGET, pane),
    (value) => value.events.some((event) => event.type === "web"
      && event.subtype === "turn-done" && event.operationKey === operationKey),
    `${config[TARGET].panes[pane].engine} ${marker}`,
    timeoutMs,
  );
  const done = snapshot.events.find((event) => event.type === "web"
    && event.subtype === "turn-done" && event.operationKey === operationKey);
  assert.equal(done.code, 0, `${marker} ended with code ${done.code}: ${done.error || done.stderr || ""}`);
  const turn = groupNativeTurns(snapshot.events).find((item) => item.operationKey === operationKey);
  assert(turn, `${marker} completed without a readable turn`);
  assert(turn.items.some((item) => item.type === "text" && item.content.includes(marker)),
    `${marker} missing from engine response`);
  return { snapshot, turn };
}

async function interruptWhenReady(pane) {
  const deadline = Date.now() + 30_000;
  let error = null;
  while (Date.now() < deadline) {
    try {
      await client.sendEscape(TARGET, pane);
      return;
    } catch (candidate) {
      error = candidate;
      if (!["interrupt-not-ready", "agent-not-running"].includes(candidate.code)) throw candidate;
      await sleep(250);
    }
  }
  throw error ?? new Error("interrupt did not become ready");
}

const proofs = {};
for (const [pane, engine] of ["claude", "codex"].entries()) {
  const firstMarker = `NATIVE_${engine.toUpperCase()}_CANARY_OK_${runId}`;
  const attachment = pane === 0 ? `\n[file attached: ${attachmentPath}]` : "";
  const first = await send(pane, "first", [
    "This is a transport canary. Do not edit any file.",
    `Reply with this marker and no other prose: ${firstMarker}`,
    attachment,
  ].join("\n"));
  const firstResult = await completedTurn(pane, first, firstMarker);
  const initialSessionId = firstResult.snapshot.agent.sessionId;
  assert(initialSessionId, `${engine} did not publish its native session id`);
  assert(Number.isFinite(firstResult.snapshot.agent.context?.percent), `${engine} did not publish context usage`);
  if (pane === 0) {
    const acceptedUser = firstResult.snapshot.events.find((event) => event.type === "web"
      && event.subtype === "user" && event.operationKey === `delivery:${first.id}`);
    assert.equal(acceptedUser?.attachments?.length, 1, "Claude attachment did not cross the native adapter");
  }

  const interruptJob = await send(pane, "interrupt-turn", [
    "This is an interrupt probe. Do not edit any file.",
    "Use the shell tool to run exactly: sleep 30",
    "After it finishes, reply INTERRUPT_PROBE_SHOULD_NOT_COMPLETE.",
  ].join("\n"));
  await waitFor(
    () => client.history(TARGET, pane),
    (value) => value.agent.running,
    `${engine} running state`,
    10_000,
  );
  const effort = await send(pane, "effort-high", "/effort high", "slash");
  assert.equal(queue.read(TARGET, pane, effort.id).status, "acknowledged");
  await interruptWhenReady(pane);
  const interruptKey = `delivery:${interruptJob.id}`;
  const interrupted = await waitFor(
    () => client.history(TARGET, pane),
    (value) => value.events.some((event) => event.type === "web"
      && event.subtype === "turn-done" && event.operationKey === interruptKey),
    `${engine} interrupt completion`,
    timeoutMs,
  );
  const interruptDone = interrupted.events.find((event) => event.type === "web"
    && event.subtype === "turn-done" && event.operationKey === interruptKey);
  assert.equal(interruptDone.interrupted, true, `${engine} turn was not marked interrupted`);
  assert.equal(interrupted.agent.sessionId, initialSessionId, `${engine} interrupt replaced the session`);
  assert.equal(interrupted.agent.effort, "high", `${engine} mid-turn effort did not apply to the next turn`);

  const resumeMarker = `NATIVE_${engine.toUpperCase()}_RESUME_OK_${runId}`;
  const resumedJob = await send(pane, "resume", [
    "The previous request was intentionally interrupted. Do not edit any file.",
    `Reply with this marker and no other prose: ${resumeMarker}`,
  ].join("\n"));
  const resumed = await completedTurn(pane, resumedJob, resumeMarker);
  assert.equal(resumed.snapshot.agent.sessionId, initialSessionId, `${engine} did not resume its session`);

  const beforeCompact = resumed.snapshot.events.length;
  await send(pane, "compact", "/compact", "slash");
  const compacted = await waitFor(
    () => client.history(TARGET, pane),
    (value) => value.events.slice(beforeCompact).some((event) =>
      event.type === "web" && event.subtype === "compact-done"),
    `${engine} compact`,
    timeoutMs,
  );
  const compactDone = compacted.events.slice(beforeCompact)
    .find((event) => event.type === "web" && event.subtype === "compact-done");
  assert.equal(compactDone.code, 0, `${engine} compact failed: ${compactDone.error || compactDone.stderr || ""}`);
  assert.equal(compacted.agent.autoCompact.contextPercent, 60);
  assert.equal(compacted.agent.autoCompact.idleMs, 5 * 60 * 1_000);

  proofs[engine] = {
    pane,
    agentId: compacted.agent.id,
    sessionId: initialSessionId,
    contextPercent: compacted.agent.context?.percent,
    usedTokens: compacted.agent.context?.usedTokens,
    interrupt: "PASS",
    resume: "PASS",
    compact: "PASS",
    effortNextTurn: compacted.agent.effort,
  };
}

// Mirror all completed pre-restart turns once, then preserve the watcher state
// while both the bridge client and the runtime process are recreated.
const watcherStorage = {};
const watcherState = {
  get: (key, fallback) => watcherStorage[key] ?? fallback,
  set: (key, value) => { watcherStorage[key] = structuredClone(value); },
};
const discordMessages = [];
const discord = {
  send: async (channelId, payload) => { discordMessages.push({ channelId, payload }); },
  sendTyping: async () => {},
};
let watcher = createNativeRuntimeWatcher({
  nativeRuntime: client,
  agentsYamlPath: "native-canary-in-memory",
  discord,
  state: watcherState,
  log: () => {},
});
for (const pane of [0, 1]) await watcher.check(TARGET, pane, config[TARGET], config);
const mirroredBeforeRestart = discordMessages.length;
assert(mirroredBeforeRestart > 0, "native watcher did not mirror completed turns");

await stopNativeRuntime({ port, stateDir, dataDir });
runtime = await startNativeRuntime({ port, stateDir, dataDir, serverPath });
assert.notEqual(runtime.health.bootId, firstBootId, "runtime restart did not create a new boot identity");
client = makeClient();
broker = createDeliveryBroker({ agent: client, queue, notify: async () => {} });
watcher = createNativeRuntimeWatcher({
  nativeRuntime: client,
  agentsYamlPath: "native-canary-in-memory",
  discord,
  state: watcherState,
  log: () => {},
});
for (const [pane, engine] of ["claude", "codex"].entries()) {
  const restored = await client.history(TARGET, pane);
  assert.equal(restored.agent.id, proofs[engine].agentId, `${engine} agent id changed after restart`);
  assert.equal(restored.agent.sessionId, proofs[engine].sessionId, `${engine} session id changed after restart`);
  await watcher.check(TARGET, pane, config[TARGET], config);
}
assert.equal(discordMessages.length, mirroredBeforeRestart,
  "runtime restart caused the Discord watcher to mirror an old turn twice");

for (const [pane, engine] of ["claude", "codex"].entries()) {
  const restartMarker = `NATIVE_${engine.toUpperCase()}_RESTART_OK_${runId}`;
  const restartedJob = await send(pane, "runtime-restart", [
    "The native runtime was restarted. Do not edit any file.",
    `Reply with this marker and no other prose: ${restartMarker}`,
  ].join("\n"));
  const restarted = await completedTurn(pane, restartedJob, restartMarker);
  assert.equal(restarted.snapshot.agent.sessionId, proofs[engine].sessionId,
    `${engine} failed to resume after runtime restart`);
  await watcher.check(TARGET, pane, config[TARGET], config);
  proofs[engine].runtimeRestart = "PASS";
}

const rendered = discordMessages.map(({ payload }) =>
  typeof payload === "string" ? payload : payload?.content || "").join("\n");
for (const engine of ["claude", "codex"]) {
  assert(rendered.includes(`NATIVE_${engine.toUpperCase()}_RESTART_OK_${runId}`),
    `${engine} post-restart response did not reach the Discord projection`);
}
assertNoCanaryTmux();

// Exercise the public compatibility surface with a fresh CLI process. This
// catches accidental calls into tmux that an in-process adapter test cannot.
const cliEnvironment = {
  ...process.env,
  AGENT_CONFIG: cliConfigPath,
  AGENTMUX_BRIDGE_DIR: ROOT,
  AMUX_DELIVERY_QUEUE_DIR: join(canaryRoot, "cli-queue", runId),
};
const runCli = (...args) => {
  const command = spawnSync(process.execPath, [join(ROOT, "bin", "agent-cli.mjs"), ...args], {
    cwd: ROOT,
    env: cliEnvironment,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(command.status, 0,
    `amux ${args.join(" ")} failed: ${command.stderr || command.stdout}`);
  return command.stdout;
};
assert.match(runCli("reconcile", TARGET), /no tmux touched/i);
assert.match(runCli("ps"), /skybar-canary/);
assert.match(runCli("log", TARGET, "-p", "0", "-n", "1"),
  new RegExp(`NATIVE_CLAUDE_RESTART_OK_${runId}`));
assert.match(runCli("done", "--since", "1h"), /skybar-canary:0/);
assert.match(runCli("stop", TARGET), /no tmux session/i);
assert((await nativeRuntimeStatus({ port, stateDir, dataDir })).online,
  "native-target stop unexpectedly stopped its runtime");
assertNoCanaryTmux();

const finalHealth = await nativeRuntimeStatus({ port, stateDir, dataDir });
const result = {
  ok: true,
  completedAt: new Date().toISOString(),
  target: TARGET,
  runId,
  runtimeUrl,
  bootRestarted: firstBootId !== finalHealth.health?.bootId,
  tmuxSessionCreated: false,
  watcherDuplicateAfterRestart: false,
  watcherMessages: discordMessages.length,
  cliCompatibility: ["reconcile", "ps", "log", "done", "stop"],
  engines: proofs,
};
const resultJson = `${JSON.stringify(result, null, 2)}\n`;
writeFileSync(join(canaryRoot, "last-result.json"), resultJson, { mode: 0o600 });
console.log(resultJson.trimEnd());

if (!options["keep-running"]) {
  await stopNativeRuntime({ port, stateDir, dataDir });
}
