// Session journals are fleet memory. Age authorizes bounded field trimming,
// never deletion: every JSONL record stays in order and remains searchable.
// Recent files are still protected exclusively by mtime. The separate
// checkpoint trim handles fresh oversized sessions after provider compaction.

import {
  appendFileSync, closeSync, fsyncSync, openSync, readFileSync, renameSync,
  statSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { trimJsonlBuffer } from "./jsonl-field-trim.mjs";
import { findSessionJsonl } from "./session-trim.mjs";
import {
  appendSessionHousekeepingAudit,
  defaultSessionHousekeepingAuditPath,
} from "./session-housekeeping-audit.mjs";

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_OVERSIZED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 100 * 1024;

/** WHAT: Returns provider session roots covered by housekeeping. WHY: Keeps Claude, Codex, and Kimi retention behavior aligned. */
export function defaultSessionRoots(home = process.env.HOME) {
  return [
    join(home, ".claude", "projects"),
    join(home, ".codex", "sessions"),
    join(home, ".kimi-code", "sessions"),
  ];
}

function sameFile(left, right) {
  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function writeAtomicReplacement(path, buffer, before, beforeCommit) {
  const temporary = `${path}.${process.pid}.${Date.now()}.amux-janitor`;
  const target = openSync(temporary, "wx", before.mode & 0o777);
  try {
    writeFileSync(target, buffer);
    fsyncSync(target);
  } catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  } finally { closeSync(target); }
  utimesSync(temporary, before.atime, before.mtime);
  if (!sameFile(before, statSync(path))) {
    unlinkSync(temporary);
    throw new Error("session-changed-during-trim");
  }
  try { beforeCommit(); }
  catch (error) {
    unlinkSync(temporary);
    throw error;
  }
  try { renameSync(temporary, path); }
  catch (error) {
    try { unlinkSync(temporary); } catch {}
    throw error;
  }
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}

// Per-file failures are collected so one bad file cannot abort a nightly run.
// Real runs append reclaimed-byte receipts beside the first root.
/** WHAT: Maps aged session journals through bounded field trim. WHY: Keeps archival cleanup from deleting fleet memory. */
export function trimAgedSessions(opts = {}) {
  const {
    roots = defaultSessionRoots(),
    retentionDays = Number(process.env.AMUX_JANITOR_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS,
    oversizedThresholdBytes = Number(process.env.AMUX_JANITOR_OVERSIZED_BYTES) || DEFAULT_OVERSIZED_BYTES,
    maxLineBytes = Number(process.env.AMUX_JANITOR_MAX_LINE_BYTES) || DEFAULT_MAX_LINE_BYTES,
    maxOversizedPaths = 10,
    dryRun = false,
    nowMs = Date.now(),
    manifestPath = null,
    auditPath = null,
  } = opts;

  const cutoffMs = nowMs - retentionDays * 24 * 3600 * 1000;
  const manifest = manifestPath || join(roots[0] || ".", ".janitor-deleted.log");
  const defaultRoots = defaultSessionRoots();
  const usesDefaultRoots = roots.length === defaultRoots.length
    && roots.every((root, index) => root === defaultRoots[index]);
  const audit = auditPath || (usesDefaultRoots
    ? defaultSessionHousekeepingAuditPath()
    : `${manifest}.audit`);
  const result = {
    scanned: 0, candidates: 0, trimmed: 0, unchanged: 0, failed: 0,
    reclaimedBytes: 0, retentionDays, dryRun, errors: [],
    oversized: 0, oversizedBytes: 0, oversizedFiles: [],
  };

  for (const root of roots) {
    for (const path of findSessionJsonl(root)) {
      result.scanned++;
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs >= cutoffMs) {
        if (st.size >= oversizedThresholdBytes) {
          result.oversized++;
          result.oversizedBytes += st.size;
          if (result.oversizedFiles.length < maxOversizedPaths) result.oversizedFiles.push(path);
        }
        continue;
      }
      result.candidates++;
      let transformed;
      try {
        transformed = trimJsonlBuffer(readFileSync(path), { maxLineBytes });
        result.reclaimedBytes += transformed.reclaimedBytes;
        if (!transformed.trimmedLines) {
          result.unchanged++;
          continue;
        }
        if (dryRun) continue;
        writeAtomicReplacement(path, transformed.buffer, st, () => {
          appendSessionHousekeepingAudit({
            operation: "replace", phase: "intent", path, bytes: st.size,
            afterBytes: transformed.afterBytes,
            reclaimedBytes: transformed.reclaimedBytes,
            reason: `retention-field-trim>${retentionDays}d`,
          }, { path: audit, now: () => nowMs });
        });
        result.trimmed++;
        try {
          appendSessionHousekeepingAudit({
            operation: "replace", phase: "completed", path, bytes: st.size,
            afterBytes: transformed.afterBytes,
            reclaimedBytes: transformed.reclaimedBytes,
            reason: `retention-field-trim>${retentionDays}d`,
          }, { path: audit, now: () => nowMs });
          const iso = new Date(nowMs).toISOString();
          const ageDays = Math.round((nowMs - st.mtimeMs) / (24 * 3600 * 1000));
          appendFileSync(
            manifest,
            `${iso}\ttrim\t${st.size}\t${transformed.afterBytes}\t${transformed.reclaimedBytes}\t${ageDays}d\t${path}\n`,
          );
        } catch (auditError) {
          result.errors.push(`${path}: trim completed but receipt append failed: ${auditError.message}`);
        }
      } catch (err) {
        try {
          appendSessionHousekeepingAudit({
            operation: "replace", phase: "failed", path, bytes: st.size,
            afterBytes: transformed?.afterBytes,
            reclaimedBytes: transformed?.reclaimedBytes,
            reason: `retention-field-trim>${retentionDays}d`, error: err.message,
          }, { path: audit, now: () => nowMs });
        } catch {}
        result.failed++;
        result.reclaimedBytes -= transformed?.reclaimedBytes || 0;
        result.errors.push(`${path}: ${err.message}`);
      }
    }
  }

  return result;
}

/** WHAT: Formats the janitor result for logs and dream output. WHY: Keeps aged field trim and untouched recent state visible together. */
export function formatJanitorResult(r) {
  const mb = (b) => (b / (1024 * 1024)).toFixed(1);
  const oversized = r.oversized
    ? `; ${r.oversized} recent oversized file(s) (${mb(r.oversizedBytes)}MB) untouched by aged trim`
    : "";
  if (r.candidates === 0) {
    return `janitor: nothing older than ${r.retentionDays}d (${r.scanned} files scanned)${oversized}`;
  }
  if (r.dryRun) {
    return `janitor (dry): would trim ${r.candidates - r.unchanged} aged file(s), reclaiming ${mb(r.reclaimedBytes)}MB; ${r.unchanged} already bounded${oversized}`;
  }
  const tail = r.failed ? `, ${r.failed} failed` : "";
  return `janitor: trimmed ${r.trimmed}/${r.candidates} aged file(s), reclaimed ${mb(r.reclaimedBytes)}MB; ${r.unchanged} already bounded${tail}${oversized}`;
}
