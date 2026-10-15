import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, closeSync, readSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { codexSessionIdentityById, latestCodexSessionIdentity } from "./codex-jsonl-reader.mjs";
import { liveRolloutWriters } from "./codex-session-guard.mjs";

function prefixMatches(older, newer) {
  const size = statSync(older).size;
  if (size > statSync(newer).size) return false;
  const left = openSync(older, "r"), right = openSync(newer, "r");
  const a = Buffer.alloc(64 * 1024), b = Buffer.alloc(64 * 1024);
  try {
    for (let offset = 0; offset < size; offset += a.length) {
      const count = Math.min(a.length, size - offset);
      if (readSync(left, a, 0, count, offset) !== count || readSync(right, b, 0, count, offset) !== count
          || !a.subarray(0, count).equals(b.subarray(0, count))) return false;
    }
    return true;
  } finally { closeSync(left); closeSync(right); }
}

/** WHAT: Stores one quiescent pane-owned session on another account. WHY: Keeps account recovery from losing history or overwriting a divergent target session. */
export function transferCodexSession(dir, current, target, { discover = latestCodexSessionIdentity, writers = liveRolloutWriters } = {}) {
  const source = discover(dir, { sessionDirs: [join(current.home, "sessions")] });
  if (!source) return { ok: false, reason: "no exact current session" };
  const fragment = relative(join(current.home, "sessions"), source.path);
  if (fragment.startsWith("..") || resolve(current.home, "sessions", fragment) !== resolve(source.path)) return { ok: false, reason: "session is outside its account home" };
  const path = join(target.home, "sessions", fragment);
  if (resolve(path) === resolve(source.path) || (existsSync(path) && realpathSync(path) === realpathSync(source.path))) return { ok: true, sessionId: source.sessionId, path };
  if (writers(path).length) return { ok: false, reason: "target session has a live writer" };
  if (existsSync(path) && !prefixMatches(path, source.path)) return { ok: false, reason: "target session differs from the source; history preserved" };
  const before = statSync(source.path, { bigint: true });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    copyFileSync(source.path, temporary);
    chmodSync(temporary, 0o600);
    const after = statSync(source.path, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ino !== after.ino) return { ok: false, reason: "source session changed during transfer" };
    if (!prefixMatches(temporary, source.path) || statSync(temporary).size !== Number(after.size)) return { ok: false, reason: "session copy did not verify" };
    renameSync(temporary, path);
    // Native resume selects by UUID, not by the path we copied. A probe under
    // another cwd can share that UUID and redirect both history and cwd.
    const unique = codexSessionIdentityById(source.sessionId, null, { sessionDirs: [join(target.home, "sessions")] });
    if (unique?.path !== path || unique.cwd !== dir) return { ok: false, reason: "target session UUID is ambiguous or belongs to another directory; history preserved" };
    return { ok: true, sessionId: source.sessionId, path };
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
