// Session-file housekeeping. Claude Code (~/.claude/projects), Codex
// (~/.codex/sessions), and Kimi (~/.kimi-code/sessions) write append-only
// jsonl logs. Two distinct problems:
//
//   1. DEAD sessions pile up forever (Codex keeps every past rollout). These
//      are safe to DELETE once old enough — nobody reads them except a rare
//      `claude --resume` or `claw search`, and weeks-old history is expendable.
//      This module handles that: delete *.jsonl with mtime past the retention
//      window.
//
//   2. LIVE sessions grow huge (100MB+) within a single run. Those are NOT a
//      janitor concern and MUST NOT be truncated here — Claude is appending to
//      them and rebuilds context from them on resume; rewriting a live file
//      corrupts the session. The only safe shrink for a live session is
//      `/compact` (rotates to a fresh small file), which agentmux automates
//      via auto-compact. After a compact the old file goes stale and THIS
//      module reaps it once it ages out.
//
// Retention is mtime-based. Deletion deliberately remains a coarse archival
// policy; it never rewrites a session in place. Recent oversized files are
// reported separately. The distinct checkpoint-aware trim module may reclaim
// only bytes the provider has already replaced with a compact summary.

import { statSync, unlinkSync, appendFileSync } from "fs";
import { join } from "path";
import { findSessionJsonl } from "./session-trim.mjs";

const DEFAULT_RETENTION_DAYS = 14;
const DEFAULT_OVERSIZED_BYTES = 64 * 1024 * 1024;

/** WHAT: Returns provider session roots covered by housekeeping. WHY: Keeps Claude, Codex, and Kimi retention behavior aligned. */
export function defaultSessionRoots(home = process.env.HOME) {
  return [
    join(home, ".claude", "projects"),
    join(home, ".codex", "sessions"),
    join(home, ".kimi-code", "sessions"),
  ];
}

// Per-file failures are collected so one bad file cannot abort a nightly run.
// Real runs append an auditable manifest line beside the first root.
/** WHAT: Saves storage by deleting expired session journals. WHY: Keeps archival cleanup from rewriting recent resumable provider state. */
export function pruneOldSessions(opts = {}) {
  const {
    roots = defaultSessionRoots(),
    retentionDays = Number(process.env.AMUX_JANITOR_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS,
    oversizedThresholdBytes = Number(process.env.AMUX_JANITOR_OVERSIZED_BYTES) || DEFAULT_OVERSIZED_BYTES,
    maxOversizedPaths = 10,
    dryRun = false,
    nowMs = Date.now(),
    manifestPath = null,
  } = opts;

  const cutoffMs = nowMs - retentionDays * 24 * 3600 * 1000;
  const manifest = manifestPath || join(roots[0] || ".", ".janitor-deleted.log");
  const result = {
    scanned: 0, candidates: 0, deleted: 0, failed: 0,
    freedBytes: 0, retentionDays, dryRun, errors: [],
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
      result.freedBytes += st.size;

      if (dryRun) continue;

      try {
        unlinkSync(path);
        result.deleted++;
        try {
          const iso = new Date(nowMs).toISOString();
          const ageDays = Math.round((nowMs - st.mtimeMs) / (24 * 3600 * 1000));
          appendFileSync(manifest, `${iso}\t${st.size}\t${ageDays}d\t${path}\n`);
        } catch {}
      } catch (err) {
        result.failed++;
        result.freedBytes -= st.size; // didn't actually free it
        result.errors.push(`${path}: ${err.message}`);
      }
    }
  }

  return result;
}

/** WHAT: Formats the janitor result for logs and dream output. WHY: Keeps deletion and untouched oversized state visible together. */
export function formatJanitorResult(r) {
  const mb = (b) => (b / (1024 * 1024)).toFixed(1);
  const oversized = r.oversized
    ? `; ${r.oversized} recent oversized file(s) (${mb(r.oversizedBytes)}MB) not age-deleted`
    : "";
  if (r.candidates === 0) {
    return `janitor: nothing older than ${r.retentionDays}d (${r.scanned} files scanned)${oversized}`;
  }
  if (r.dryRun) {
    return `janitor (dry): would delete ${r.candidates} file(s) older than ${r.retentionDays}d, freeing ${mb(r.freedBytes)}MB${oversized}`;
  }
  const tail = r.failed ? `, ${r.failed} failed` : "";
  return `janitor: deleted ${r.deleted}/${r.candidates} file(s) older than ${r.retentionDays}d, freed ${mb(r.freedBytes)}MB${tail}${oversized}`;
}
