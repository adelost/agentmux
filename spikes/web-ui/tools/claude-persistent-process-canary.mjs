#!/usr/bin/env node

// Live, isolated comparison of Claude's two local stream-json lifecycles:
// one process kept alive across turns, and today's spawn + --resume per turn.
// This is deliberately opt-in because it consumes real subscription quota.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  claudeInterruptRequest,
  claudeUserMessage,
  writeClaudeMessage,
} from "../runtime-control.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 5_000;

function parseArgs(argv) {
  const options = { model: "haiku", corpusLines: 120, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--model") options.model = value;
    else if (key === "--corpus-lines") options.corpusLines = Number(value);
    else if (key === "--timeout") options.timeoutMs = Number(value);
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  assert.match(options.model, /^[a-zA-Z0-9._-]{1,80}$/, "invalid --model");
  assert(Number.isSafeInteger(options.corpusLines) && options.corpusLines >= 20
    && options.corpusLines <= 1_000, "--corpus-lines must be 20..1000");
  assert(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs >= 10_000
    && options.timeoutMs <= 600_000, "--timeout must be 10000..600000");
  return options;
}

function subscriptionAuth(command) {
  assert(!process.env.ANTHROPIC_API_KEY,
    "ANTHROPIC_API_KEY is set; refusing a subscription-vs-API billing canary");
  const result = spawnSync(command, ["auth", "status"], { encoding: "utf8" });
  assert.equal(result.status, 0, "claude auth status failed");
  const status = JSON.parse(result.stdout);
  assert.equal(status.loggedIn, true, "Claude CLI is not logged in");
  assert.equal(status.authMethod, "claude.ai", "canary requires Claude subscription auth");
  assert(status.subscriptionType, "Claude auth did not report a subscription type");
  return {
    authMethod: status.authMethod,
    apiProvider: status.apiProvider,
    subscriptionType: status.subscriptionType,
  };
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDECODE|CLAUDE_CODE_)/i.test(key)) delete env[key];
  }
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function redact(value) {
  return String(value ?? "")
    .replace(/(authorization|api[_-]?key|token)\s*[:=]\s*[^\s,]+/gi, "$1=[redacted]")
    .slice(-4_000);
}

function baseArgs({ model, name, sessionId = null }) {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--replay-user-messages",
    "--model", model,
    "--effort", "low",
    "--name", name,
    "--safe-mode",
    "--no-chrome",
    "--disable-slash-commands",
    "--tools", "Bash",
    "--dangerously-skip-permissions",
    "--append-system-prompt",
    "This is an isolated AMUX transport canary. Never inspect or modify files. "
      + "Only run the exact sleep command when explicitly requested, and otherwise reply exactly as requested.",
  ];
  if (sessionId) args.push("--resume", sessionId);
  return args;
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
    child.once("close", () => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

function groupAlive(child) {
  if (!child?.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForGroupExit(child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupAlive(child)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !groupAlive(child);
}

function signalGroup(child, signal) {
  if (!child?.pid) return;
  try { process.kill(-child.pid, signal); } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

async function closeProcess(child) {
  if (!child) return;
  try { child.stdin?.end?.(); } catch {}
  await waitForExit(child, SHUTDOWN_GRACE_MS);
  if (await waitForGroupExit(child, 250)) return;
  signalGroup(child, "SIGTERM");
  if (await waitForGroupExit(child, 2_000)) return;
  signalGroup(child, "SIGKILL");
  assert(await waitForGroupExit(child, 2_000), `Claude process group ${child.pid} did not exit`);
}

class ClaudeStream {
  constructor({ command, args, cwd, timeoutMs }) {
    this.events = [];
    this.waiters = new Set();
    this.stderr = "";
    this.timeoutMs = timeoutMs;
    this.child = spawn(command, args, {
      cwd,
      env: childEnv(),
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.pid = this.child.pid;
    this.closed = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.exit = { code, signal };
        for (const waiter of this.waiters) {
          clearTimeout(waiter.timeout);
          waiter.reject(new Error(`Claude exited before ${waiter.label}: ${code ?? signal}`));
        }
        this.waiters.clear();
        resolve(this.exit);
      });
    });
    this.child.once("error", (error) => {
      for (const waiter of this.waiters) waiter.reject(error);
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${redact(chunk)}`.slice(-4_000);
    });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        event = { type: "protocol_error", line: line.slice(0, 1_000) };
      }
      this.events.push(event);
      for (const waiter of [...this.waiters]) {
        if (this.events.length <= waiter.from || !waiter.predicate(event)) continue;
        clearTimeout(waiter.timeout);
        this.waiters.delete(waiter);
        waiter.resolve(event);
      }
    });
  }

  waitFor(predicate, label, { from = 0, timeoutMs = this.timeoutMs } = {}) {
    const found = this.events.slice(from).find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, label, from, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`${label} timed out after ${timeoutMs}ms; stderr=${redact(this.stderr)}`));
      }, timeoutMs);
      waiter.timeout.unref?.();
      this.waiters.add(waiter);
    });
  }

  async turn(prompt, expected) {
    const from = this.events.length;
    writeClaudeMessage(this.child, claudeUserMessage(prompt));
    const result = await this.waitFor((event) => event.type === "result", expected, { from });
    assert.equal(result.subtype, "success", `${expected} failed: ${result.subtype}`);
    assert.match(String(result.result ?? ""), new RegExp(expected), `${expected} response mismatch`);
    return result;
  }

  async close() {
    await closeProcess(this.child);
  }
}

const valueOf = (source, snake, camel) => Number(source?.[snake] ?? source?.[camel] ?? 0) || 0;

function usageOf(result) {
  const usage = Array.isArray(result?.usage?.iterations)
    ? result.usage.iterations.at(-1) ?? result.usage
    : result?.usage ?? {};
  let normalized = {
    input: valueOf(usage, "input_tokens", "inputTokens"),
    cacheCreate: valueOf(usage, "cache_creation_input_tokens", "cacheCreationInputTokens"),
    cacheRead: valueOf(usage, "cache_read_input_tokens", "cacheReadInputTokens"),
    output: valueOf(usage, "output_tokens", "outputTokens"),
  };
  if (!Object.values(normalized).some(Boolean)) {
    const models = Object.values(result?.modelUsage ?? {});
    normalized = models.reduce((total, model) => ({
      input: total.input + valueOf(model, "input_tokens", "inputTokens"),
      cacheCreate: total.cacheCreate
        + valueOf(model, "cache_creation_input_tokens", "cacheCreationInputTokens"),
      cacheRead: total.cacheRead
        + valueOf(model, "cache_read_input_tokens", "cacheReadInputTokens"),
      output: total.output + valueOf(model, "output_tokens", "outputTokens"),
    }), { input: 0, cacheCreate: 0, cacheRead: 0, output: 0 });
  }
  return {
    ...normalized,
    processed: normalized.input + normalized.cacheCreate + normalized.cacheRead + normalized.output,
  };
}

function sumUsage(turns) {
  return turns.map(usageOf).reduce((total, usage) => ({
    input: total.input + usage.input,
    cacheCreate: total.cacheCreate + usage.cacheCreate,
    cacheRead: total.cacheRead + usage.cacheRead,
    output: total.output + usage.output,
    processed: total.processed + usage.processed,
  }), { input: 0, cacheCreate: 0, cacheRead: 0, output: 0, processed: 0 });
}

const observedModels = (turns) => [...new Set(turns.flatMap((turn) =>
  Object.keys(turn?.modelUsage ?? {})))];

function corpus(tag, lines) {
  return Array.from({ length: lines }, (_, index) => {
    const digest = createHash("sha256").update(`${tag}:${index}`).digest("hex");
    return `${String(index + 1).padStart(4, "0")}: ${digest} ${digest.slice(0, 24)}`;
  }).join("\n");
}

function prompts(tag, lines) {
  const text = corpus(tag, lines);
  return [
    [`Treat the following as reference material. Do not use tools.\n${text}\nReply exactly: BOOT_${tag}`, `BOOT_${tag}`],
    [`Do not use tools. Reply exactly: SECOND_${tag}`, `SECOND_${tag}`],
    [`Do not use tools. Reply exactly: THIRD_${tag}`, `THIRD_${tag}`],
  ];
}

async function runPersistent({ command, cwd, model, timeoutMs, corpusLines, tag }) {
  const stream = new ClaudeStream({
    command,
    args: baseArgs({ model, name: `amux-persistent-${tag}` }),
    cwd,
    timeoutMs,
  });
  try {
    const turns = [];
    for (const [prompt, expected] of prompts(tag, corpusLines)) {
      turns.push(await stream.turn(prompt, expected));
      assert.equal(stream.child.exitCode, null, "persistent Claude exited between turns");
    }
    const sessionIds = turns.map((turn) => turn.session_id);
    assert(sessionIds[0], "persistent Claude did not report a session id");
    assert.equal(new Set(sessionIds).size, 1, "persistent Claude changed session id between turns");

    const interruptFrom = stream.events.length;
    writeClaudeMessage(stream.child, claudeUserMessage([
      "This is an interrupt probe.",
      "Use the Bash tool to run exactly: sleep 20",
      "After it finishes, reply INTERRUPT_SHOULD_NOT_COMPLETE.",
    ].join("\n")));
    await stream.waitFor((event) => event.type === "assistant"
      && event.message?.content?.some((block) => block?.type === "tool_use"
        && block.name === "Bash" && String(block.input?.command ?? "").includes("sleep 20")),
    "interrupt probe tool start", { from: interruptFrom });
    const interrupt = claudeInterruptRequest();
    writeClaudeMessage(stream.child, interrupt);
    const control = await stream.waitFor((event) => event.type === "control_response"
      && event.response?.request_id === interrupt.request_id,
    "interrupt control response", { from: interruptFrom });
    assert.equal(control.response?.subtype, "success", "Claude rejected interrupt control request");
    const interrupted = await stream.waitFor((event) => event.type === "result",
      "interrupted turn result", { from: interruptFrom });
    assert.equal(interrupted.subtype, "error_during_execution",
      `interrupt returned unexpected result: ${interrupted.subtype}`);
    assert.equal(stream.child.exitCode, null, "interrupt killed the persistent Claude process");

    const recovered = await stream.turn(
      `The interruption was intentional. Do not use tools. Reply exactly: RECOVERED_${tag}`,
      `RECOVERED_${tag}`,
    );
    assert.equal(recovered.session_id, sessionIds[0], "Claude recovery changed session id");
    return {
      pid: stream.pid,
      sessionId: sessionIds[0],
      observedModels: observedModels([...turns, interrupted, recovered]),
      turnUsage: turns.map(usageOf),
      totalUsage: sumUsage(turns),
      interrupt: "PASS",
      postInterruptRecovery: "PASS",
    };
  } finally {
    await stream.close();
  }
}

async function runSpawnResume({ command, cwd, model, timeoutMs, corpusLines, tag }) {
  let sessionId = null;
  const pids = [];
  const turns = [];
  for (const [prompt, expected] of prompts(tag, corpusLines)) {
    const stream = new ClaudeStream({
      command,
      args: baseArgs({ model, name: `amux-resume-${tag}`, sessionId }),
      cwd,
      timeoutMs,
    });
    pids.push(stream.pid);
    try {
      const result = await stream.turn(prompt, expected);
      if (!sessionId) sessionId = result.session_id;
      assert.equal(result.session_id, sessionId, "spawn + resume changed session id");
      turns.push(result);
    } finally {
      await stream.close();
    }
  }
  assert.equal(new Set(pids).size, pids.length, "spawn + resume unexpectedly reused a process");
  return {
    pids,
    sessionId,
    observedModels: observedModels(turns),
    turnUsage: turns.map(usageOf),
    totalUsage: sumUsage(turns),
  };
}

function economics(persistent, resumed) {
  const persistentLater = persistent.turnUsage.slice(1).reduce((sum, turn) => sum + turn.cacheCreate, 0);
  const resumedLater = resumed.turnUsage.slice(1).reduce((sum, turn) => sum + turn.cacheCreate, 0);
  if (!persistentLater && !resumedLater) return {
    comparison: "cache-creation-input-tokens on turns 2-3 only",
    verdict: "no-cache-write-signal",
    persistentLater,
    resumedLater,
  };
  const ratio = resumedLater ? Number((persistentLater / resumedLater).toFixed(3)) : null;
  const verdict = resumedLater === 0
    ? "inconclusive-resume-zero"
    : ratio <= 1.1 ? "persistent-no-worse" : ratio >= 1.5 ? "persistent-regressed" : "inconclusive-close";
  return {
    comparison: "cache-creation-input-tokens on turns 2-3 only",
    verdict,
    persistentLater,
    resumedLater,
    ratio,
  };
}

const options = parseArgs(process.argv.slice(2));
const command = process.env.CLAUDE_BIN || "claude";
const auth = subscriptionAuth(command);
const root = mkdtempSync(join(tmpdir(), "amux-claude-persistent-canary-"));
const persistentCwd = join(root, "persistent");
const resumeCwd = join(root, "spawn-resume");
mkdirSync(persistentCwd, { recursive: true, mode: 0o700 });
mkdirSync(resumeCwd, { recursive: true, mode: 0o700 });
writeFileSync(join(persistentCwd, "README.txt"), "isolated AMUX Claude process canary\n", { mode: 0o600 });
writeFileSync(join(resumeCwd, "README.txt"), "isolated AMUX Claude resume canary\n", { mode: 0o600 });

try {
  const persistent = await runPersistent({
    command,
    cwd: persistentCwd,
    ...options,
    tag: `P${randomUUID().replaceAll("-", "").slice(0, 10)}`,
  });
  const spawnResume = await runSpawnResume({
    command,
    cwd: resumeCwd,
    ...options,
    tag: `R${randomUUID().replaceAll("-", "").slice(0, 10)}`,
  });
  const proof = {
    ok: true,
    claudeVersion: spawnSync(command, ["--version"], { encoding: "utf8" }).stdout.trim(),
    auth,
    model: options.model,
    corpusLines: options.corpusLines,
    persistent,
    spawnResume,
    cacheEconomics: economics(persistent, spawnResume),
  };
  process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
