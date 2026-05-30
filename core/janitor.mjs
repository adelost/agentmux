// Session-file housekeeping. Claude Code (~/.claude/projects) and Codex
// (~/.codex/sessions) write append-only jsonl logs that grow without bound —
// a single long-running session reaches 100MB+, and Codex keeps every past
// rollout forever. These are the source of truth for `--resume`, so we must
// NOT truncate active files. Instead we gzip files no agent has touched in a
// while: ~90% reclaimed, fully reversible (gunzip), and invisible to every
// reader here since they all glob `*.jsonl` (not `.jsonl.gz`).
//
// Safety model is mtime-based and needs no tmux cross-reference: an active
// pane rewrites its jsonl constantly, so anything older than the retention
// window is provably a dead session. The newest file is never a candidate
// because its mtime is fresh.

import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, unlinkSync, utimesSync } from "fs";
import { join } from "path";
import { gzipSync } from "zlib";

const DEFAULT_RETENTION_DAYS = 30;

/** Recursively collect every *.jsonl path under `dir` (skips already-gzipped). */
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
 * Gzip session jsonl files older than the retention window across the given
 * roots. Never throws — individual file failures are collected and skipped so
 * one bad file can't abort a nightly run.
 *
 * @param {object} opts
 * @param {string[]} [opts.roots]        - dirs to scan (default: claude + codex)
 * @param {number}   [opts.retentionDays]- archive files older than this (default 30)
 * @param {boolean}  [opts.dryRun]       - report only, change nothing
 * @param {number}   [opts.nowMs]        - injectable clock for tests
 * @returns {{ scanned, candidates, archived, failed, reclaimedBytes, retentionDays, dryRun }}
 */
export function archiveOldSessions(opts = {}) {
  const {
    roots = [
      join(process.env.HOME, ".claude", "projects"),
      join(process.env.HOME, ".codex", "sessions"),
    ],
    retentionDays = Number(process.env.AMUX_JANITOR_RETENTION_DAYS) || DEFAULT_RETENTION_DAYS,
    dryRun = false,
    nowMs = Date.now(),
  } = opts;

  const cutoffMs = nowMs - retentionDays * 24 * 3600 * 1000;
  const result = {
    scanned: 0, candidates: 0, archived: 0, failed: 0,
    reclaimedBytes: 0, retentionDays, dryRun, errors: [],
  };

  for (const root of roots) {
    for (const path of findJsonlRecursive(root)) {
      result.scanned++;
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs >= cutoffMs) continue; // touched recently → live, skip
      result.candidates++;

      if (dryRun) {
        // Estimate: text jsonl gzips to ~10% of size. Don't read the file.
        result.reclaimedBytes += Math.round(st.size * 0.9);
        continue;
      }

      try {
        const gzPath = path + ".gz";
        const raw = readFileSync(path);
        writeFileSync(gzPath, gzipSync(raw, { level: 6 }));
        // Preserve mtime on the archive so a future retention pass (or the
        // user) can still reason about session age.
        try { utimesSync(gzPath, st.atime, st.mtime); } catch {}
        const gzSize = statSync(gzPath).size;
        unlinkSync(path);
        result.archived++;
        result.reclaimedBytes += st.size - gzSize;
      } catch (err) {
        result.failed++;
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
    return `janitor (dry): ${r.candidates} file(s) older than ${r.retentionDays}d, ~${mb(r.reclaimedBytes)}MB reclaimable`;
  }
  const tail = r.failed ? `, ${r.failed} failed` : "";
  return `janitor: archived ${r.archived}/${r.candidates} file(s) older than ${r.retentionDays}d, ${mb(r.reclaimedBytes)}MB reclaimed${tail}`;
}
