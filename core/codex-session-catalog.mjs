import { readdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { codexSessionDirs } from "./codex-profiles.mjs";

// Cache session_meta payload by file path. session_meta is the first event
// in a rollout file and is immutable for the lifetime of the session, so we
// only re-parse when mtime changes (which it won't for cwd, but invalidates
// cleanly if the user edits the file e.g. to fix a wrong cwd). Without
// this, latestSessionFor() reads every jsonl file (potentially 23MB each,
// hundreds of them) on every poll tick — saturating the bridge at 90% CPU.
const sessionMetaCache = new Map(); // filePath → { mtimeMs, payload }

/** WHAT: Reads bounded rollout directories. WHY: Keeps session discovery inside configured profile roots. */
export function findJsonlFiles(dir, depth = 0, acc = [], directories = null) {
  if (depth > 4) return acc;
  if (directories) directories.push({ path: dir, stamp: directoryStamp(dir) });
  if (!existsSync(dir)) return acc;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return acc; }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) findJsonlFiles(path, depth + 1, acc, directories);
    else if (e.name.endsWith(".jsonl")) acc.push(path);
  }
  return acc;
}

// Session_meta lives on line 1 of every rollout. In real codex sessions it
// includes payload.instructions which can run 21-34KB. Read in 64KB chunks
// until we hit a newline, capping at 256KB as a sanity ceiling — anything
// larger would mean the file isn't a codex rollout. With cache hits dominating
// after the first sweep, the worst-case "scan all 186 sessions" cost is ~12MB
// of disk reads once, vs the old 290MB per poll-tick.
const SESSION_META_CHUNK = 64 * 1024;
const SESSION_META_CAP = 256 * 1024;

/**
 * Read just the session_meta event from a file. session_meta is always the
 * FIRST line in a codex rollout, but its payload.instructions field can push
 * line 1 past 30KB. Read incrementally until we find the newline (or hit cap)
 * instead of mapping the entire (potentially 23MB) file.
 *
 * Cached by (path, mtime) so subsequent polls hit memory unless the file's
 * mtime changes — which the cwd field doesn't, since session_meta is written
 * once at session start and never rewritten.
 */
/** WHAT: Reads one rollout header. WHY: Keeps session identity separate from large mutable event tails. */
export function readSessionMeta(filePath) {
  let mtimeMs;
  try { mtimeMs = statSync(filePath).mtimeMs; }
  catch { return null; }

  const cached = sessionMetaCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.payload;

  let payload = null;
  let fd = null;
  try {
    fd = openSync(filePath, "r");
    const chunks = [];
    let totalRead = 0;
    let firstLine = null;

    while (totalRead < SESSION_META_CAP) {
      const buf = Buffer.alloc(SESSION_META_CHUNK);
      const bytesRead = readSync(fd, buf, 0, SESSION_META_CHUNK, totalRead);
      if (bytesRead === 0) break; // EOF
      chunks.push(buf.subarray(0, bytesRead));
      totalRead += bytesRead;

      // Concat-and-search is O(totalRead) per iteration but bounded by cap;
      // simpler than tracking newline scan position across chunks.
      const head = Buffer.concat(chunks).toString("utf-8");
      const newlineIdx = head.indexOf("\n");
      if (newlineIdx !== -1) {
        firstLine = head.slice(0, newlineIdx);
        break;
      }
      if (bytesRead < SESSION_META_CHUNK) break; // partial chunk = EOF, no newline
    }

    if (firstLine && firstLine.trim()) {
      try {
        const event = JSON.parse(firstLine);
        if (event.type === "session_meta") payload = event.payload;
      } catch { /* malformed first line — leave payload null */ }
    }
  } catch { /* fd open failed, leave payload null */ }
  finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* swallow */ } }
  }

  sessionMetaCache.set(filePath, { mtimeMs, payload });
  return payload;
}

/** WHAT: Reads catalog directory identity. WHY: Keeps new rollouts immediately visible to cached observation readers. */
export function directoryStamp(path) {
  try { const s = statSync(path, { bigint: true }); return `${s.ino}:${s.mtimeNs}:${s.ctimeNs}`; }
  catch { return null; }
}

/** WHAT: Builds one session discovery view. WHY: Keeps shared observations separate from independent physical delivery lookup. */
export function captureCodexSessionCatalog(sessionDirs = codexSessionDirs()) {
  const directories = [], paths = sessionDirs.flatMap(base => findJsonlFiles(base, 0, [], directories));
  return { directories, files: paths.map(path => ({ path, mtime: statSync(path).mtimeMs, meta: readSessionMeta(path) })) };
}
