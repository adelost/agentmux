// Checkpoint-aware compaction for recent provider journals. Retention age and
// physical size are separate concerns: old sessions may be deleted, while a
// young oversized session may only shed bytes that its provider has already
// replaced with an explicit compact summary.

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync,
  readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const MIB = 1024 * 1024;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})/iu;
const DEFAULT_THRESHOLD = 64 * MIB;
const DEFAULT_STABLE_MS = 10 * 60_000;
const COPY_CHUNK = 4 * MIB;

// The marker is the provider's own semantic replacement boundary. Keeping a
// random byte tail would corrupt resume; these two records explicitly replace
// everything before them with a summary/replacement_history.
/** WHAT: Defines provider-owned semantic trim boundaries. WHY: Keeps checkpoint policy separate from byte-copy mechanics. */
export const TRIM_STRATEGIES = Object.freeze([
  Object.freeze({
    provider: "claude",
    pathPart: "/.claude/projects/",
    marker: Buffer.from(',"type":"system","subtype":"compact_boundary"'),
  }),
  Object.freeze({
    provider: "codex",
    pathPart: "/.codex/sessions/",
    marker: Buffer.from(',"type":"compacted","payload":{"message":'),
  }),
]);

/** WHAT: Collects provider journals once. WHY: Keeps Janitor and trim from classifying different files. */
export function findSessionJsonl(dir, depth = 0, acc = []) {
  if (depth > 6 || !existsSync(dir)) return acc;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) findSessionJsonl(path, depth + 1, acc);
    else if (entry.name.endsWith(".jsonl")) acc.push(path);
  }
  return acc;
}

/** WHAT: Reads live provider session IDs from process argv. WHY: Prevents a closed idle fd from posing as an inactive TUI. */
export function liveNativeSessionIds({ procRoot = "/proc" } = {}) {
  const ids = new Set();
  let pids;
  try { pids = readdirSync(procRoot).filter((name) => /^\d+$/u.test(name)); }
  catch { return null; } // fail closed: caller protects every candidate
  for (const pid of pids) {
    let argv;
    try { argv = readFileSync(join(procRoot, pid, "cmdline"), "utf8").split("\0").filter(Boolean); }
    catch { continue; }
    const executable = basename(argv[0] || "").toLowerCase();
    if (!/^(?:claude|codex|kimi|kimi-code)$/u.test(executable)) continue;
    for (const arg of argv.slice(1)) {
      for (const match of arg.matchAll(new RegExp(UUID.source, "giu"))) ids.add(match[1].toLowerCase());
    }
  }
  return ids;
}

function strategyFor(path) {
  const normalized = path.replaceAll("\\", "/");
  return TRIM_STRATEGIES.find((strategy) => normalized.includes(strategy.pathPart)) || null;
}

function sessionIdFor(path) {
  return UUID.exec(basename(path))?.[1]?.toLowerCase() || null;
}

function readFirstLine(path, maxBytes = 4 * MIB) {
  const fd = openSync(path, "r");
  const chunks = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes - total));
      const count = readSync(fd, chunk, 0, chunk.length, total);
      if (!count) break;
      const part = chunk.subarray(0, count);
      const newline = part.indexOf(0x0a);
      chunks.push(newline >= 0 ? part.subarray(0, newline + 1) : part);
      total += newline >= 0 ? newline + 1 : count;
      if (newline >= 0) return Buffer.concat(chunks);
    }
  } finally { closeSync(fd); }
  return null;
}

function lineStartBefore(path, at) {
  const fd = openSync(path, "r");
  let end = at;
  try {
    while (end > 0) {
      const start = Math.max(0, end - 64 * 1024);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
  } finally { closeSync(fd); }
  return 0;
}

/** WHAT: Resolves the newest provider checkpoint with bounded reads. WHY: Keeps giant journals from becoming giant heap allocations. */
export function findLastCheckpoint(path, marker, size = statSync(path).size) {
  const fd = openSync(path, "r");
  const overlapBytes = Math.max(128, marker.length * 2);
  let end = size;
  let laterPrefix = Buffer.alloc(0);
  try {
    while (end > 0) {
      const start = Math.max(0, end - COPY_CHUNK);
      const chunk = Buffer.alloc(end - start);
      readSync(fd, chunk, 0, chunk.length, start);
      const combined = laterPrefix.length ? Buffer.concat([chunk, laterPrefix]) : chunk;
      const found = combined.lastIndexOf(marker);
      if (found >= 0 && found < chunk.length) return lineStartBefore(path, start + found);
      laterPrefix = chunk.subarray(0, Math.min(overlapBytes, chunk.length));
      end = start;
    }
  } finally { closeSync(fd); }
  return null;
}

function sameFile(left, right) {
  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function copyRange(sourcePath, targetFd, start, end) {
  const sourceFd = openSync(sourcePath, "r");
  let offset = start;
  try {
    while (offset < end) {
      const chunk = Buffer.alloc(Math.min(COPY_CHUNK, end - offset));
      const count = readSync(sourceFd, chunk, 0, chunk.length, offset);
      if (!count) throw new Error("source-ended-during-trim");
      writeSync(targetFd, chunk, 0, count);
      offset += count;
    }
  } finally { closeSync(sourceFd); }
}

/** WHAT: Saves one stable inactive journal from its provider checkpoint. WHY: Prevents physical size from authorizing resume-history loss. */
export function trimCheckpointedSession(path, {
  nowMs = Date.now(), minStableMs = DEFAULT_STABLE_MS, dryRun = false,
  liveIds = liveNativeSessionIds(), refreshLiveIds = liveNativeSessionIds,
} = {}) {
  const strategy = strategyFor(path);
  if (!strategy) return { path, status: "protected", reason: "unsupported-provider" };
  const before = statSync(path);
  const sessionId = sessionIdFor(path);
  if (!sessionId) return { path, provider: strategy.provider, status: "protected", reason: "session-id-missing" };
  if (liveIds === null || liveIds.has(sessionId)) {
    return { path, provider: strategy.provider, status: "protected", reason: liveIds === null ? "live-scan-unavailable" : "active-session" };
  }
  if (nowMs - before.mtimeMs < minStableMs) {
    return { path, provider: strategy.provider, status: "protected", reason: "recently-changing" };
  }
  const firstLine = readFirstLine(path);
  if (!firstLine) return { path, provider: strategy.provider, status: "protected", reason: "header-oversized-or-incomplete" };
  const checkpoint = findLastCheckpoint(path, strategy.marker, before.size);
  if (checkpoint == null) return { path, provider: strategy.provider, status: "protected", reason: "needs-compact" };
  const afterBytes = firstLine.length + before.size - checkpoint;
  if (checkpoint < firstLine.length || afterBytes >= before.size) {
    return { path, provider: strategy.provider, status: "protected", reason: "checkpoint-not-reclaiming" };
  }
  const result = { path, provider: strategy.provider, status: dryRun ? "would-trim" : "trimmed", beforeBytes: before.size, afterBytes, reclaimedBytes: before.size - afterBytes };
  if (dryRun) return result;

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.amux-trim`;
  const target = openSync(temporary, "wx", before.mode & 0o777);
  try {
    writeSync(target, firstLine);
    copyRange(path, target, checkpoint, before.size);
    fsyncSync(target);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  } finally { closeSync(target); }

  const current = statSync(path);
  const refreshed = refreshLiveIds();
  if (!sameFile(before, current) || refreshed === null || refreshed.has(sessionId)) {
    unlinkSync(temporary);
    return { path, provider: strategy.provider, status: "protected", reason: "changed-during-trim" };
  }
  try { renameSync(temporary, path); }
  catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  const directoryFd = openSync(dirname(path), "r");
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  return result;
}

/** WHAT: Dispatches one declarative policy across oversized journals. WHY: Keeps startup and manual trim from drifting apart. */
export function trimOversizedSessions({
  roots, thresholdBytes = DEFAULT_THRESHOLD, minStableMs = DEFAULT_STABLE_MS,
  maxFiles = Infinity, nowMs = Date.now(), dryRun = false, trimOne = trimCheckpointedSession,
} = {}) {
  const liveIds = liveNativeSessionIds();
  const result = { scanned: 0, oversized: 0, trimmed: 0, wouldTrim: 0, reclaimedBytes: 0, protected: 0, reasons: {}, files: [] };
  for (const path of (roots || []).flatMap((root) => findSessionJsonl(root))) {
    result.scanned++;
    let size;
    try { size = statSync(path).size; } catch { continue; }
    if (size < thresholdBytes) continue;
    result.oversized++;
    if (result.trimmed + result.wouldTrim >= maxFiles) {
      result.protected++;
      result.reasons["startup-limit"] = (result.reasons["startup-limit"] || 0) + 1;
      continue;
    }
    let item;
    try { item = trimOne(path, { nowMs, minStableMs, dryRun, liveIds }); }
    catch (error) { item = { path, status: "protected", reason: `error:${error.message}` }; }
    result.files.push(item);
    if (item.status === "trimmed") result.trimmed++;
    else if (item.status === "would-trim") result.wouldTrim++;
    else {
      result.protected++;
      result.reasons[item.reason] = (result.reasons[item.reason] || 0) + 1;
    }
    result.reclaimedBytes += item.reclaimedBytes || 0;
  }
  return result;
}

/** WHAT: Formats one bounded trim receipt. WHY: Keeps reclaimed and protected bytes from being conflated. */
export function formatTrimResult(result) {
  const mib = (bytes) => (bytes / MIB).toFixed(1);
  const action = result.wouldTrim ? `would trim ${result.wouldTrim}` : `trimmed ${result.trimmed}`;
  const reasons = Object.entries(result.reasons).map(([reason, count]) => `${reason}=${count}`).join(", ");
  return `trim: ${action}/${result.oversized} oversized, reclaim ${mib(result.reclaimedBytes)}MB${result.protected ? `; protected ${result.protected}${reasons ? ` (${reasons})` : ""}` : ""}`;
}
