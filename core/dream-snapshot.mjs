import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const IDENTITY = / · run `([0-9a-f-]{36})` · source `([0-9a-f]{64})`\./u;
const SNAPSHOT = /<!-- amux-dream-snapshot:(\d{4}-\d{2}-\d{2}) ([0-9a-f-]{36}) ([0-9a-f]{64}) ([0-9a-f]{64}) -->/u;

function readSnapshot(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 14 * 1024) throw new Error("invalid Dream snapshot file");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

function snapshotBytes(content, dateKey) {
  return Buffer.from([
    "<!-- template: reference -->",
    `> summary: Verifierat nattminne för ${dateKey}. Nya uppgifter skrivs i dagsanteckningen, inte här.`,
    "> why: Bevarar det exakta kuraterade resultatet separat från redigerbara anteckningar.",
    "", String(content).trim(), "",
  ].join("\n"));
}

/** WHAT: Stores an immutable Markdown result and returns its daily reference. WHY: Prevents normal note editing from rewriting a verified Dream product. */
export function publishDreamSnapshot(memPath, content, dateKey, included, omitted) {
  const identity = String(content).split(/\r?\n/u)[0].match(IDENTITY);
  if (!identity || !/^\d{4}-\d{2}-\d{2}$/u.test(dateKey)) throw new Error("invalid Dream snapshot identity");
  const [, runId, sourceSha] = identity;
  const relativePath = `dream/${[dateKey, runId].join("-")}.md`;
  const path = join(dirname(memPath), relativePath), bytes = snapshotBytes(content, dateKey);
  if (bytes.length > 14 * 1024) throw new Error("Dream snapshot exceeds byte limit");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o400);
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    try { linkSync(temporary, path); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!readSnapshot(path).equals(bytes)) throw new Error("Dream snapshot already exists with different bytes");
    }
  } finally { unlinkSync(temporary); }
  const dir = openSync(dirname(path), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
  const sha256 = hash(bytes);
  return {
    path, sha256, runId, sourceSha,
    block: [
      `<!-- amux-dream-summary:${dateKey} -->`,
      "## Nightly fleet summary",
      `> ${included.length} panel(s) included; ${omitted.length} omitted by fixed limits.`,
      `[Läs den verifierade Dream-sammanfattningen](${relativePath}). Nya uppgifter skrivs nedanför detta block.`,
      `<!-- amux-dream-snapshot:${dateKey} ${runId} ${sourceSha} ${sha256} -->`,
      `<!-- /amux-dream-summary:${dateKey} -->`,
    ].join("\n"),
  };
}

/** WHAT: Reads a typed snapshot identity from the daily reference. WHY: Prevents arbitrary Markdown links from selecting a trusted result. */
export function dreamSnapshotReference(block, dateKey) {
  const found = String(block).match(SNAPSHOT);
  if (!found || found[1] !== dateKey) return null;
  return { runId: found[2], sourceSha: found[3], sha256: found[4] };
}

/** WHAT: Checks the frozen result against the original model artifact. WHY: Prevents an edited snapshot or copied reference from becoming a success receipt. */
export function verifyDreamSnapshot(workspace, dateKey, reference, content) {
  const path = join(workspace, "memory", "dream", `${[dateKey, reference.runId].join("-")}.md`);
  try {
    const bytes = readSnapshot(path);
    if (hash(bytes) !== reference.sha256 || !bytes.equals(snapshotBytes(content, dateKey))) return null;
    return path;
  } catch { return null; }
}
