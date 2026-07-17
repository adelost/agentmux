#!/usr/bin/env node
// Push canonical per-agent context snapshots to Suggestions.
// Uses `amux top --json`; engine log parsing remains centralized in
// core/context.mjs. The local state provides durable lost-response replay and
// compact generation fences.

import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync,
  readSync, renameSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import yaml from "js-yaml";
import {
  emptyContextPushState,
  normalizeContextPushState,
  parseFleetProjects,
  reconcileContextTelemetry,
} from "../core/suggestions-context-telemetry.mjs";

const execFile = promisify(execFileCallback);
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "agent", "suggestions-quota-push.yaml");
const DEFAULT_FLEETS_PATH = join(homedir(), ".agentmux", "fleet-watch", "fleets.conf");
const DEFAULT_EVENTS_PATH = join(homedir(), ".agentmux", "events.jsonl");
const DEFAULT_STATE_PATH = join(homedir(), ".agentmux", "suggestions-context-push-state.json");
const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;
const PUSH_TIMEOUT_MS = 15_000;

const expandHome = (value) => typeof value === "string" && value.startsWith("~/")
  ? join(homedir(), value.slice(2))
  : value;

export function loadContextPushConfig(raw) {
  const parsed = yaml.load(raw);
  const baseUrl = typeof parsed?.baseUrl === "string" ? parsed.baseUrl.replace(/\/+$/u, "") : "";
  const credentialFile = expandHome(parsed?.adminCredentialFile);
  if (!baseUrl || typeof credentialFile !== "string" || !credentialFile) {
    throw new Error("config requires baseUrl and adminCredentialFile");
  }
  const heartbeat = Number(parsed?.contextHeartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  if (!Number.isSafeInteger(heartbeat) || heartbeat < 60_000 || heartbeat > 60 * 60 * 1000) {
    throw new Error("contextHeartbeatMs must be an integer between 60000 and 3600000");
  }
  return {
    baseUrl,
    credentialFile,
    fleetConfigFile: expandHome(parsed?.contextFleetConfigFile) || DEFAULT_FLEETS_PATH,
    eventsFile: expandHome(parsed?.contextEventsFile) || DEFAULT_EVENTS_PATH,
    stateFile: expandHome(parsed?.contextStateFile) || DEFAULT_STATE_PATH,
    heartbeatMs: heartbeat,
  };
}

export function loadContextState(path) {
  if (!existsSync(path)) return emptyContextPushState();
  try { return normalizeContextPushState(JSON.parse(readFileSync(path, "utf-8"))); }
  catch (error) { throw new Error(`invalid context state ${path}: ${error.message}`); }
}

export function saveContextState(path, state) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

/** Read only complete new event-ledger lines and advance a byte cursor safely. */
export function readCompactEvents(path, cursor = 0) {
  if (!existsSync(path)) return { cursor: 0, events: [] };
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const start = size < cursor ? 0 : cursor;
    if (size === start) return { cursor: start, events: [] };
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const newline = buffer.lastIndexOf(0x0a);
    if (newline < 0) return { cursor: start, events: [] };
    const events = [];
    for (const line of buffer.subarray(0, newline).toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.event !== "session_start" || event?.source !== "compact") continue;
      if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(event?.session || "")) continue;
      if (!Number.isSafeInteger(Number(event?.pane)) || Number(event.pane) < 0) continue;
      const at = new Date(event.ts || event.at || 0);
      if (!Number.isFinite(at.getTime())) continue;
      events.push({ agentId: `${event.session}:${Number(event.pane)}`, at: at.toISOString() });
    }
    return { cursor: start + newline + 1, events };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export async function readTopSnapshot({
  agentCli = join(__dirname, "agent-cli.mjs"),
  execFileImpl = execFile,
} = {}) {
  const { stdout } = await execFileImpl(process.execPath, [agentCli, "top", "--json"], {
    encoding: "utf-8",
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  const snapshot = JSON.parse(stdout);
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.agents)) {
    throw new Error("amux top --json returned an unsupported snapshot");
  }
  return snapshot;
}

async function postContext(baseUrl, token, payload, fetchImpl) {
  const response = await fetchImpl(`${baseUrl}/api/ops/context`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "agentmux-context-push/1",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    const body = await response.text().catch(() => "");
    throw new Error(`push failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }
  return response.json().catch(() => ({}));
}

export async function pushContextOnce({
  config,
  token,
  fetchImpl = globalThis.fetch,
  readTop = readTopSnapshot,
  uuid = randomUUID,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("context push requires fetch");
  let state = loadContextState(config.stateFile);

  // A response may have been lost after the board committed. Retry the exact
  // same body and only then advance local state; server mutationId replay makes
  // this at-most-once without losing the sample.
  if (state.pending) {
    await postContext(config.baseUrl, token, state.pending.payload, fetchImpl);
    state = normalizeContextPushState(state.pending.nextState);
    saveContextState(config.stateFile, state);
  }

  const snapshot = await readTop();
  const ledger = readCompactEvents(config.eventsFile, state.eventCursor);
  const projectBySession = parseFleetProjects(readFileSync(config.fleetConfigFile, "utf-8"));
  const reconciled = reconcileContextTelemetry({
    state,
    snapshot,
    compactEvents: ledger.events,
    projectBySession,
    mutationId: uuid(),
    nowMs: now(),
    heartbeatMs: config.heartbeatMs,
    eventCursor: ledger.cursor,
  });
  if (!reconciled.payload) {
    saveContextState(config.stateFile, reconciled.state);
    return { pushed: false, samples: 0, compacts: 0 };
  }

  const pendingState = {
    ...state,
    eventCursor: reconciled.state.eventCursor,
    pending: { payload: reconciled.payload, nextState: reconciled.state },
  };
  saveContextState(config.stateFile, pendingState);
  await postContext(config.baseUrl, token, reconciled.payload, fetchImpl);
  saveContextState(config.stateFile, reconciled.state);
  return {
    pushed: true,
    samples: reconciled.payload.samples.length,
    compacts: reconciled.payload.compacts.length,
  };
}

async function main() {
  const configPath = process.argv[2] || DEFAULT_CONFIG_PATH;
  const config = loadContextPushConfig(readFileSync(configPath, "utf-8"));
  const token = readFileSync(config.credentialFile, "utf-8").trim();
  if (!token) throw new Error(`empty admin token in ${config.credentialFile}`);
  const result = await pushContextOnce({ config, token });
  console.log(result.pushed
    ? `pushed context (${result.samples} samples, ${result.compacts} compacts)`
    : "context unchanged");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && basename(invokedPath) === basename(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`suggestions-context-push: ${error.message}`);
    process.exitCode = 1;
  });
}
