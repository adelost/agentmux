// Attachment backups for durable delivery jobs. A backup is written before
// link(2) decides who created the job, so it is named by its bytes and linked,
// never copied over: a replay with the same job id and other bytes lands beside
// the first backup instead of replacing it.

import {
  chmodSync, closeSync, copyFileSync, existsSync, linkSync, mkdirSync, openSync, readSync, unlinkSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { basename, dirname, join } from "path";

const ATTACHMENT_MARKER = /\[(?:image|file) attached:\s+([^\]\n]+)\]/gi;

/** WHAT: Calculates a file's sha256 in bounded chunks. WHY: Keeps large attachments from loading whole into memory. */
export function fileSha256(path) {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(1 << 20);
  const fd = openSync(path, "r");
  try {
    for (let read; (read = readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** WHAT: Saves each attached file into [assetDir] under a name carrying its sha256. WHY: Prevents a same-id replay from overwriting the first job's backup. */
export function persistAttachmentBackups(text, assetDir, { ensureDir, uuid = randomUUID }) {
  const originals = [...String(text).matchAll(ATTACHMENT_MARKER)].map((match) => match[1].trim());
  if (!originals.length) return [];
  ensureDir(assetDir);
  return originals.flatMap((original, index) => {
    if (!existsSync(original)) return [];
    const tmp = join(assetDir, `.${process.pid}.${uuid()}.tmp`);
    copyFileSync(original, tmp);
    try {
      try { chmodSync(tmp, 0o600); } catch {}
      const sha256 = fileSha256(tmp);
      const backup = join(assetDir, `${String(index).padStart(2, "0")}-${sha256.slice(0, 16)}-${basename(original)}`);
      try { linkSync(tmp, backup); } catch (error) { if (error?.code !== "EEXIST") throw error; }
      return [{ original, backup, sha256 }];
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  });
}

/** WHAT: Checks a replay's attachment bytes against the first job's backups. WHY: Keeps a same-key replay with other bytes named instead of silently merged. */
export function attachmentReplayConflict(firstAssets = [], replayAssets = []) {
  const differs = replayAssets.some((asset) => {
    const first = firstAssets.find((item) => item.original === asset.original);
    if (!first) return false;
    const firstSha256 = first.sha256 ?? (existsSync(first.backup) ? fileSha256(first.backup) : null);
    return firstSha256 !== asset.sha256;
  });
  return differs ? { replayConflict: "attachment_bytes_differ" } : {};
}

/** WHAT: Returns backups to original paths that have disappeared. WHY: Keeps attachments available to an agent after temp cleanup or a bridge restart. */
export function restoreAttachmentBackups(job) {
  let restored = 0;
  for (const asset of job.assets || []) {
    if (!asset?.original || !asset?.backup || existsSync(asset.original) || !existsSync(asset.backup)) continue;
    mkdirSync(dirname(asset.original), { recursive: true });
    copyFileSync(asset.backup, asset.original);
    restored++;
  }
  return restored;
}
