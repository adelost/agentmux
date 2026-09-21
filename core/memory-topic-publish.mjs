import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { acquireFileLease } from "./file-lease.mjs";
import { inspectTopic, readTopicFile, topicDirectory, topicHash } from "./memory-topics.mjs";

function persist(path, bytes, flags = "wx") {
  const fd = openSync(path, flags, 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** WHAT: Stores one reviewed topic with its previous version preserved. WHY: Keeps failed validation or interrupted writes from replacing usable memory. */
export function publishMemoryTopic(workspace, candidate) {
  const dir = topicDirectory(workspace);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lease = acquireFileLease(join(dir, ".publish.lock"));
  if (!lease) throw new Error("topic publisher busy; retry after the current publication");
  try {
    const bytes = readTopicFile(candidate);
    const checked = inspectTopic(workspace, candidate, { text: bytes.toString("utf8") });
    if (checked.state === "INVALID" || checked.facts.source !== "MATCH") throw new Error(`topic refused: ${checked.state} ${checked.reason || "source versions do not match"}`);
    const target = join(dir, `${checked.meta.id}.md`);
    const previous = existsSync(target) ? readTopicFile(target) : null;
    if (previous && topicHash(previous) === topicHash(bytes)) return { path: target, state: checked.state, changed: false, sha256: checked.sha256 };
    if (previous) {
      const archive = join(dir, ".history", checked.meta.id, `${topicHash(previous)}.md`);
      mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
      if (!existsSync(archive)) persist(archive, previous);
      else if (topicHash(readTopicFile(archive)) !== topicHash(previous)) throw new Error("topic archive hash mismatch");
      syncDirectory(dirname(archive));
    }
    const temporary = join(dir, `.${checked.meta.id}.${randomUUID()}.tmp`);
    persist(temporary, bytes);
    const rechecked = inspectTopic(workspace, candidate, { text: bytes.toString("utf8") });
    if (rechecked.facts.source !== "MATCH") throw new Error("source changed during topic publication; original retained");
    renameSync(temporary, target);
    syncDirectory(dir);
    return { path: target, state: checked.state, changed: true, sha256: checked.sha256 };
  } finally { lease.release(); }
}
