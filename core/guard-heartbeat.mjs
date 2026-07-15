// Durable liveness snapshots for the scheduled guards that protect agentmux.
// A guard writes only after a successful sweep. Doctor reads the fixed
// registry, so a missing writer is visible instead of silently disappearing.

import {
  chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

const guard = (key, intervalSec, label = key) => Object.freeze({ key, intervalSec, label });

export const GUARD_CRON_REGISTRY = Object.freeze([
  guard("fleet-progress", 20 * 60),
  guard("task-keeper", 29 * 60),
  guard("watchdog-outbox", 60),
  guard("comment-bridge", 60),
  guard("backlog-pull", 15 * 60),
  guard("board-curator", 60 * 60),
]);

const REGISTRY_BY_KEY = new Map(GUARD_CRON_REGISTRY.map((entry) => [entry.key, entry]));
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const METRIC_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;

export const guardHeartbeatDir = () => process.env.AMUX_GUARD_HEARTBEAT_DIR
  || join(homedir(), ".agentmux", "guard-heartbeats");

export const guardHeartbeatPath = (key, dir = guardHeartbeatDir()) => {
  if (!KEY_PATTERN.test(String(key))) throw new Error(`invalid guard key '${key}'`);
  return join(dir, `${key}.json`);
};

const normalizeMetrics = (metrics = {}) => Object.fromEntries(Object.entries(metrics).map(([key, value]) => {
  if (!METRIC_KEY_PATTERN.test(key)) throw new Error(`invalid guard metric '${key}'`);
  if (value == null || typeof value === "boolean" || typeof value === "string") {
    return [key, typeof value === "string" ? value.slice(0, 240) : value];
  }
  if (typeof value === "number" && Number.isFinite(value)) return [key, value];
  throw new Error(`guard metric '${key}' must be a finite scalar`);
}));

export function writeGuardHeartbeat({
  key,
  intervalSec = REGISTRY_BY_KEY.get(key)?.intervalSec,
  metrics = {},
  now = new Date(),
  dir = guardHeartbeatDir(),
} = {}) {
  if (!REGISTRY_BY_KEY.has(key)) throw new Error(`unknown guard '${key}'`);
  if (!Number.isSafeInteger(intervalSec) || intervalSec < 1 || intervalSec > 24 * 60 * 60) {
    throw new Error("guard intervalSec must be an integer from 1 to 86400");
  }
  const date = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(date.getTime())) throw new Error("guard heartbeat timestamp is invalid");
  const path = guardHeartbeatPath(key, dir);
  const beat = Object.freeze({
    schemaVersion: 1,
    key,
    ts: date.toISOString(),
    intervalSec,
    metrics: Object.freeze(normalizeMetrics(metrics)),
  });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(beat)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
  return beat;
}

export function readGuardHeartbeat(key, dir = guardHeartbeatDir()) {
  try {
    return JSON.parse(readFileSync(guardHeartbeatPath(key, dir), "utf8"));
  } catch {
    return null;
  }
}

export const readGuardHeartbeats = ({
  dir = guardHeartbeatDir(),
  registry = GUARD_CRON_REGISTRY,
} = {}) => registry.map((entry) => Object.freeze({
  ...entry,
  beat: readGuardHeartbeat(entry.key, dir),
}));

export function classifyGuardHeartbeat(entry, { now = Date.now() } = {}) {
  const beat = entry?.beat;
  if (!beat) return Object.freeze({ ...entry, state: "missing", ageMs: null });
  const at = new Date(beat.ts).getTime();
  const intervalSec = Number(beat.intervalSec);
  if (beat.schemaVersion !== 1 || beat.key !== entry.key || !Number.isFinite(at)
    || !Number.isSafeInteger(intervalSec) || intervalSec !== entry.intervalSec
    || at > now + 5_000) {
    return Object.freeze({ ...entry, state: "invalid", ageMs: null });
  }
  const ageMs = Math.max(0, now - at);
  const staleAfterMs = entry.intervalSec * 2 * 1000;
  return Object.freeze({
    ...entry,
    beat,
    intervalSec,
    ageMs,
    staleAfterMs,
    state: ageMs > staleAfterMs ? "stale" : "ok",
  });
}
