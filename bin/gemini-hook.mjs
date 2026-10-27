#!/usr/bin/env node
// Observation only: the CLI owns its composer, tools, authentication and transcript.
import { constants, openSync, writeSync, fsyncSync, closeSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { GEMINI_FORBIDDEN_ENV } from "../core/gemini-launch.mjs";

const HOOKS = new Set(["SessionStart", "BeforeAgent", "AfterAgent", "SessionEnd"]);
const MAX_HOOK_BYTES = 8 * 1024 * 1024;

/** WHAT: Builds a durable session/generation-bound lifecycle receipt. WHY: Keeps terminal paint separate from proof a delivery reached Gemini. */
export function recordGeminiHook(input, env = process.env) {
  const path = env.AMUX_GEMINI_EVENTS;
  const generation = env.AMUX_GEMINI_GENERATION;
  const sessionId = env.AMUX_GEMINI_SESSION_ID;
  const cwd = env.AMUX_GEMINI_CWD;
  if (!path || !isAbsolute(path) || !/^[a-z0-9._-]{1,160}$/iu.test(generation || "")
      || basename(path) !== `events-${generation}.jsonl` || !cwd || !isAbsolute(cwd)
      || !/^[0-9a-f-]{36}$/iu.test(sessionId || "")) throw new Error("invalid hook binding");
  if (!input || !HOOKS.has(input.hook_event_name)) throw new Error("unsupported hook");
  if (input.session_id !== sessionId || !input.cwd || resolve(input.cwd) !== resolve(cwd)) {
    throw new Error("foreign hook identity");
  }
  const record = { ...input, generation, observedAt: new Date().toISOString() };
  if (input.hook_event_name === "SessionStart") {
    record.environment = Object.fromEntries(GEMINI_FORBIDDEN_ENV.map(name => [name, Object.hasOwn(env, name)]));
  }
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return { ok: true };
}

async function main() {
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_HOOK_BYTES) throw new Error("hook input exceeds bound");
      chunks.push(chunk);
    }
    recordGeminiHook(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    process.stdout.write("{}\n");
  } catch {
    // Do not echo a failed payload: a hook may contain private prompt or tool data.
    process.stderr.write("GEMINI_HOOK_REJECTED: invalid input or generation binding\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
