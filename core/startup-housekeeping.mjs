// Bounded storage housekeeping run immediately before a fresh bridge starts.
// AMUX owns bridge.log and may safely rotate it while no bridge process is
// alive. Provider session journals are never byte-trimmed: old sessions follow
// the existing retention policy, while recent large sessions are reported.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defaultSessionRoots, formatJanitorResult, pruneOldSessions } from "./janitor.mjs";

const DEFAULT_MAX_LOG_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP_LOG_BYTES = 2 * 1024 * 1024;

/** WHAT: Saves the bounded tail of one closed AMUX-owned log atomically. WHY: Prevents bridge restarts from rereading an ever-growing log. */
export function rotateClosedLog(path, {
  maxBytes = DEFAULT_MAX_LOG_BYTES,
  keepBytes = DEFAULT_KEEP_LOG_BYTES,
} = {}) {
  if (!existsSync(path)) return { path, rotated: false, beforeBytes: 0, afterBytes: 0 };
  const beforeBytes = statSync(path).size;
  if (beforeBytes <= maxBytes) return { path, rotated: false, beforeBytes, afterBytes: beforeBytes };

  const readBytes = Math.min(keepBytes, beforeBytes);
  const source = openSync(path, "r");
  let buffer = Buffer.alloc(readBytes);
  try {
    const count = readSync(source, buffer, 0, readBytes, beforeBytes - readBytes);
    buffer = buffer.subarray(0, count);
  } finally {
    closeSync(source);
  }
  if (beforeBytes > readBytes) {
    const firstLineEnd = buffer.indexOf(0x0a);
    buffer = firstLineEnd >= 0 ? buffer.subarray(firstLineEnd + 1) : Buffer.alloc(0);
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.trim`;
  const target = openSync(temporary, "w", 0o600);
  try {
    if (buffer.length) writeSync(target, buffer);
    fsyncSync(target);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  } finally {
    closeSync(target);
  }
  renameSync(temporary, path);
  return { path, rotated: true, beforeBytes, afterBytes: buffer.length };
}

/** WHAT: Checks and cleans bounded startup storage. WHY: Keeps clean serve retention from touching resumable live journals. */
export function runStartupHousekeeping({
  env = process.env,
  bridgeLogPath = resolve(env.AMUX_BRIDGE_LOG || join(env.HOME, ".agentmux", "bridge.log")),
  roots = defaultSessionRoots(env.HOME),
  nowMs = Date.now(),
} = {}) {
  const log = rotateClosedLog(bridgeLogPath, {
    maxBytes: Number(env.AMUX_BRIDGE_LOG_MAX_BYTES) || DEFAULT_MAX_LOG_BYTES,
    keepBytes: Number(env.AMUX_BRIDGE_LOG_KEEP_BYTES) || DEFAULT_KEEP_LOG_BYTES,
  });
  const sessions = pruneOldSessions({
    roots,
    nowMs,
    retentionDays: Number(env.AMUX_JANITOR_RETENTION_DAYS) || undefined,
    oversizedThresholdBytes: Number(env.AMUX_JANITOR_OVERSIZED_BYTES) || undefined,
  });
  return { log, sessions };
}

/** WHAT: Formats one concise startup receipt. WHY: Keeps changed and intentionally untouched storage visible to operators. */
export function formatStartupHousekeeping({ log, sessions }) {
  const mib = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
  const logSummary = log.rotated
    ? `bridge.log ${mib(log.beforeBytes)}→${mib(log.afterBytes)}MB`
    : `bridge.log ${mib(log.beforeBytes)}MB`;
  return `storage: ${logSummary}; ${formatJanitorResult(sessions)}`;
}
