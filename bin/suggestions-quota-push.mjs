#!/usr/bin/env node
// Push the local weekly-quota snapshot to the Suggestions board.
// Counterpart of the board's POST/GET /api/ops/quota: the board stores the
// latest snapshot and shows the hint only to the authority owner. Freshness
// is cron-paced by design ("behöver inte vara instant", Mattias 2026-07-15).
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { readQuotaSnapshot } from "../core/quota-usage.mjs";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "agent", "suggestions-quota-push.yaml");
const DEFAULT_STATE_PATH = join(homedir(), ".agentmux", "suggestions-quota-push-events.jsonl");
const PUSH_TIMEOUT_MS = 15_000;
/** WHAT: Names the installed push cadence. WHY: Keeps stale-delivery alerts aligned with cron. */
export const QUOTA_PUSH_INTERVAL_MS = 15 * 60_000;

const expandHome = (value) =>
  typeof value === "string" && value.startsWith("~/")
    ? join(homedir(), value.slice(2))
    : value;

/** WHAT: Parses quota delivery configuration. WHY: Keeps credentials and state paths explicit. */
export function loadPushConfig(raw) {
  const parsed = yaml.load(raw);
  const baseUrl = typeof parsed?.baseUrl === "string" ? parsed.baseUrl.replace(/\/+$/u, "") : "";
  const credentialFile = expandHome(parsed?.adminCredentialFile);
  const statePath = expandHome(parsed?.statePath
    ?? process.env.AMUX_QUOTA_PUSH_STATE ?? DEFAULT_STATE_PATH);
  if (!baseUrl || typeof credentialFile !== "string" || !credentialFile) {
    throw new Error("config requires baseUrl and adminCredentialFile");
  }
  if (typeof statePath !== "string" || !statePath) throw new Error("config statePath is invalid");
  return { baseUrl, credentialFile, statePath };
}

export function quotaPushSummary(snapshot) {
  const engineState = (engine) =>
    snapshot[engine]?.ok ? `${engine} ok` : `${engine} ${snapshot[engine]?.error || "missing"}`;
  return `pushed quota snapshot (${engineState("claude")}, ${engineState("codex")})`;
}

const PUSH_OUTCOMES = new Set(["success", "failure", "lock_skip"]);
const classifiedReason = (value) => typeof value === "string"
  && /^[a-z0-9_:-]{2,80}$/u.test(value) ? value : null;

/** WHAT: Stores one fsynced delivery outcome. WHY: Keeps failures and lock skips visible across restarts. */
export function recordQuotaPushEvent(statePath, event, { now = Date.now } = {}) {
  if (typeof statePath !== "string" || !statePath || !PUSH_OUTCOMES.has(event?.outcome)) {
    throw new Error("quota push event is invalid");
  }
  const at = new Date(now()).toISOString();
  if (at === "Invalid Date") throw new Error("quota push event clock is invalid");
  const reason = event.outcome === "failure" ? classifiedReason(event.reason) : null;
  if (event.outcome === "failure" && !reason) throw new Error("quota push failure reason is invalid");
  const durable = { version: 1, at, outcome: event.outcome, ...(reason ? { reason } : {}) };
  mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
  const descriptor = openSync(statePath, "a", 0o600);
  try {
    writeSync(descriptor, `${JSON.stringify(durable)}\n`, null, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return durable;
}

/** WHAT: Reads valid durable delivery outcomes. WHY: Keeps torn or foreign ledger rows from health state. */
export function readQuotaPushEvents(statePath) {
  let text;
  try { text = readFileSync(statePath, "utf8"); }
  catch { return []; }
  return text.split("\n").flatMap((line) => {
    if (!line) return [];
    try {
      const event = JSON.parse(line);
      const at = Date.parse(event?.at);
      return event?.version === 1 && PUSH_OUTCOMES.has(event.outcome) && Number.isFinite(at)
        && (event.outcome !== "failure" || classifiedReason(event.reason)) ? [event] : [];
    } catch { return []; }
  });
}

/** WHAT: Reports time since verified Suggest delivery. WHY: Keeps stopped cron from looking current. */
export function quotaPushDeliveryHealth(statePath, {
  now = Date.now,
  intervalMs = QUOTA_PUSH_INTERVAL_MS,
} = {}) {
  const events = readQuotaPushEvents(statePath);
  const last = events.at(-1) ?? null;
  const success = events.findLast((event) => event.outcome === "success") ?? null;
  const baseline = success ?? events[0] ?? null;
  if (!baseline) return { state: "unavailable", reason: "no-delivery-history",
    ageMs: null, lastOutcome: null, lastSuccessfulAt: null };
  const ageMs = Math.max(0, now() - Date.parse(baseline.at));
  const overdue = ageMs > 2 * intervalMs;
  return {
    state: overdue ? "alert" : "nominal",
    reason: overdue ? "suggestions-delivery-stale" : null,
    ageMs,
    lastOutcome: last?.outcome ?? null,
    lastSuccessfulAt: success?.at ?? null,
  };
}

const defaultStatePath = () => process.env.AMUX_QUOTA_PUSH_STATE || DEFAULT_STATE_PATH;

const recordedPushResult = (statePath, event, result, { now }) => {
  const previousHealth = quotaPushDeliveryHealth(statePath, { now });
  recordQuotaPushEvent(statePath, event, { now });
  return { ...result, health: quotaPushDeliveryHealth(statePath, { now }), previousHealth };
};

/** WHAT: Dispatches and records the exact Code snapshot. WHY: Keeps Suggest from observing a second collection. */
export async function pushQuotaSnapshot(snapshot, {
  configPath = DEFAULT_CONFIG_PATH,
  fetchImpl = fetch,
  now = Date.now,
  timeoutMs = PUSH_TIMEOUT_MS,
} = {}) {
  let config;
  try { config = loadPushConfig(readFileSync(configPath, "utf8")); }
  catch {
    const statePath = defaultStatePath();
    return recordedPushResult(statePath,
      { outcome: "failure", reason: "config_unavailable" },
      { ok: false, error: "config_unavailable" }, { now });
  }
  let token;
  try { token = readFileSync(config.credentialFile, "utf8").trim(); }
  catch { token = ""; }
  if (!token) {
    return recordedPushResult(config.statePath,
      { outcome: "failure", reason: "credential_unavailable" },
      { ok: false, error: "credential_unavailable" }, { now });
  }
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/api/ops/quota`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "agentmux-quota-push/2",
      },
      body: JSON.stringify({ version: 1, snapshot }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return recordedPushResult(config.statePath,
      { outcome: "failure", reason: "network_error" },
      { ok: false, error: "network_error" }, { now });
  }
  if (response.status !== 204) {
    const reason = `http_${Number(response.status) || 0}`;
    return recordedPushResult(config.statePath, { outcome: "failure", reason },
      { ok: false, error: reason }, { now });
  }
  return recordedPushResult(config.statePath, { outcome: "success" }, { ok: true }, { now });
}

/** WHAT: Collects and delivers one quota snapshot. WHY: Keeps cron on the shared observation producer. */
export async function runQuotaPush({
  configPath = DEFAULT_CONFIG_PATH,
  readSnapshot = readQuotaSnapshot,
  fetchImpl = fetch,
  now = Date.now,
} = {}) {
  let snapshot;
  try { snapshot = await readSnapshot(); }
  catch {
    const statePath = defaultStatePath();
    return recordedPushResult(statePath, { outcome: "failure", reason: "collector_failed" },
      { ok: false, error: "collector_failed" }, { now });
  }
  const delivery = await pushQuotaSnapshot(snapshot, { configPath, fetchImpl, now });
  return { ...delivery, snapshot };
}

async function main() {
  if (process.argv[2] === "--record-lock-skip") {
    const statePath = process.argv[3] || defaultStatePath();
    recordQuotaPushEvent(statePath, { outcome: "lock_skip" });
    const health = quotaPushDeliveryHealth(statePath);
    console.log("quota push skipped: lock held");
    if (health.state === "alert") {
      console.error(`ALERT suggestions quota delivery stale (${health.ageMs}ms)`);
      process.exitCode = 1;
    }
    return;
  }
  const result = await runQuotaPush({ configPath: process.argv[2] || DEFAULT_CONFIG_PATH });
  if (result.health?.state === "alert" || result.previousHealth?.state === "alert") {
    console.error(`ALERT suggestions quota delivery stale (${result.health?.ageMs ?? result.previousHealth.ageMs}ms)`);
  }
  if (!result.ok) throw new Error(result.error);
  console.log(quotaPushSummary(result.snapshot));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath && basename(invokedPath) === basename(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(`suggestions-quota-push: ${error.message}`);
    process.exitCode = 1;
  });
}
