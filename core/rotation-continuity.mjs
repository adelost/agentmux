// Account switching uses persisted engine history, never a turn on the old account.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { NATIVE_SESSION_ID } from "./native-session-identity.mjs";

/** WHAT: Reads a bounded exact-session continuity fence. WHY: Prevents rotation from replacing a pane after its journal changed or while its last record is incomplete. */
export function readRotationContinuity(identity) {
  if (!NATIVE_SESSION_ID.test(identity?.sessionId || "") || !identity?.path || !identity?.cwd
      || basename(identity.path) !== `${identity.sessionId}.jsonl`) throw new Error("rotation-session-unproven");
  const path = realpathSync(identity.path), fd = openSync(path, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size === 0) throw new Error("rotation-journal-empty");
    const tail = Buffer.alloc(Math.min(before.size, 64 * 1024));
    if (readSync(fd, tail, 0, tail.length, before.size - tail.length) !== tail.length
        || tail.at(-1) !== 10) throw new Error("rotation-journal-incomplete");
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("rotation-journal-changing");
    return { sessionId: identity.sessionId, cwd: resolve(identity.cwd), path, dev: after.dev, ino: after.ino,
      size: after.size, mtimeMs: after.mtimeMs, tailSha256: createHash("sha256").update(tail).digest("hex") };
  } finally { closeSync(fd); }
}

/** WHAT: Checks the saved session at the restart boundary. WHY: Prevents a new turn, session or journal replacement from being discarded after preflight. */
export function assertRotationContinuity(expected, identity) {
  const current = readRotationContinuity(identity);
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error("rotation-session-changed");
  return current;
}
