// Append-only forensic journal for destructive provider-session housekeeping.
// An intent row is durable before deletion/replacement; completion follows it.

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SESSION_HOUSEKEEPING_AUDIT_VERSION = 1;

export function defaultSessionHousekeepingAuditPath(home = homedir()) {
  return process.env.AMUX_SESSION_HOUSEKEEPING_AUDIT_PATH
    || join(home, ".agentmux", "session-housekeeping.jsonl");
}

export function appendSessionHousekeepingAudit(entry, {
  path = defaultSessionHousekeepingAuditPath(),
  now = () => Date.now(),
} = {}) {
  if (!entry?.path) throw new Error("session housekeeping audit requires path");
  if (!new Set(["delete", "replace"]).has(entry?.operation)) {
    throw new Error("session housekeeping audit requires delete or replace operation");
  }
  if (!new Set(["intent", "completed", "failed"]).has(entry?.phase)) {
    throw new Error("session housekeeping audit requires intent, completed, or failed phase");
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { chmodSync(dirname(path), 0o700); } catch {}
  const row = {
    version: SESSION_HOUSEKEEPING_AUDIT_VERSION,
    ts: new Date(Number(now())).toISOString(),
    operation: entry.operation,
    phase: entry.phase,
    path: String(entry.path),
    bytes: Number.isFinite(Number(entry.bytes)) ? Number(entry.bytes) : null,
    reason: String(entry.reason || "unspecified"),
    provider: entry.provider ? String(entry.provider) : null,
    error: entry.error ? String(entry.error) : null,
  };
  appendFileSync(path, `${JSON.stringify(row)}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
  return row;
}
