// Session-file housekeeping. Claude Code (~/.claude/projects) and Codex
// (~/.codex/sessions) write append-only jsonl logs. Two distinct problems:
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
// Safety is mtime-based and needs no tmux cross-reference: an active pane
// rewrites its jsonl continuously, so its mtime is always seconds old —
// provably below any multi-day cutoff. The failure mode is one-directional:
// worst case we keep a file we could have deleted, never delete a live one.

import { readdirSync, statSync, existsSync, unlinkSync, appendFileSync } from "fs";
import { join } from "path";

const DEFAULT_RETENTION_DAYS = 14;

function defaultRoots() {
  return [
    join(process.env.HOME, ".claude", "projects"),
    join(process.env.HOME, ".codex", "sessions"),
  ];
}

/** Recursively collect every *.jsonl path under `dir`. */
function findJsonlRecursive(dir, depth = 0, acc = []) {
  if (depth > 6 || !existsSync(dir)) return acc;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) findJsonlRecursive(path, depth + 1, acc);
    else if (e.name.endsWith(".jsonl")) acc.push(path);
  }
  return acc;
}

/**
 * Delete session jsonl files older than the retention window. Never throws —
 * per-file failures are collected so one bad file can't abort a nightly run.
 * On a real run, appends a manifest line per deleted file to a log alongside
 * the first root, so deletions stay auditable/recoverable-from-knowledge.
 *
 * @param {object} opts
 * @param {string[]} [opts.roots]         - dirs to scan (default: claude + codex)
 * @param {number}   [opts.retentionDays] - delete files older than this (default 14)
 * @param {boolean}  [opts.dryRun]        - report only, delete nothing
 * @param {number}   [opts.nowMs]         - injectable clock for tests
 * @param {string|null} [opts.manifestPath] - override manifest log location
 * @returns {{ scanned, candidates, deleted, failed, freedBytes, retentionDays, dryRun, errors }}
 */
export function pruneOldSessions(opts = {}) {
  const {
    roots = defaultRoots(),
    retentionDays = Number(process.env.AMUX_JANITOR_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS,
    dryRun = false,
    nowMs = Date.now(),
    manifestPath = null,
  } = opts;

  const cutoffMs = nowMs - retentionDays * 24 * 3600 * 1000;
  const manifest = manifestPath || join(roots[0] || ".", ".janitor-deleted.log");
  const result = {
    scanned: 0, candidates: 0, deleted: 0, failed: 0,
    freedBytes: 0, retentionDays, dryRun, errors: [],
  };

  for (const root of roots) {
    for (const path of findJsonlRecursive(root)) {
      result.scanned++;
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs >= cutoffMs) continue; // touched recently → live, keep
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

/** Human one-liner for logs / dream output. */
export function formatJanitorResult(r) {
  const mb = (b) => (b / (1024 * 1024)).toFixed(1);
  if (r.candidates === 0) {
    return `janitor: nothing older than ${r.retentionDays}d (${r.scanned} files scanned)`;
  }
  if (r.dryRun) {
    return `janitor (dry): would delete ${r.candidates} file(s) older than ${r.retentionDays}d, freeing ${mb(r.freedBytes)}MB`;
  }
  const tail = r.failed ? `, ${r.failed} failed` : "";
  return `janitor: deleted ${r.deleted}/${r.candidates} file(s) older than ${r.retentionDays}d, freed ${mb(r.freedBytes)}MB${tail}`;
}
