// WHAT: Publishes new references and an append-only index suffix from a frozen care receipt.
// WHY: Existing shared files and other writers' edits must not be replaced by the curator's snapshot.
import { closeSync, constants, existsSync, fstatSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { acquireFileLease } from "./file-lease.mjs";
import { assertDreamWritePath, readDreamRegular } from "./dream-memory-effects.mjs";
import { careHash } from "./dream-care-workspace.mjs";
import { writeDreamAtomic } from "./dream-commit.mjs";

/** WHAT: Stores this verified run's additive filesystem publication. WHY: Prevents a retry from buying another model turn or replacing changed memory. */
export function publishDreamCare(workspace, input) {
  const path = input.path.replace(/\.json$/u, ".care.json");
  if (!existsSync(path)) return { state: "refused", reason: "care-receipt-missing" };
  const report = JSON.parse(readDreamRegular(path, 512 * 1024));
  if (report.sourceSha256 !== input.sha256) throw Error("dream-care-receipt-source-mismatch");
  if (["published", "refused", "unknown"].includes(report.state)) return { state: report.state, reason: report.reason, files: report.applied || [] };
  const save = () => writeDreamAtomic(path, JSON.stringify(report) + "\n");
  const lease = acquireFileLease(join(workspace, "memory", ".care-publish.lock"));
  if (!lease) return { state: "refused", reason: "care-publisher-busy" };
  let fd;
  try {
    for (const [file, expected] of Object.entries(report.sourceHashes)) {
      if (file === "MEMORY.md") continue;
      assertDreamWritePath(join(workspace, file));
      if (careHash(readDreamRegular(join(workspace, file), 128 * 1024)) !== expected) throw Error("dream-care-source-changed");
    }
    const index = join(workspace, "MEMORY.md"); assertDreamWritePath(index);
    fd = openSync(index, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    const inode = fstatSync(fd), current = readFileSync(fd, "utf8");
    if (!current.startsWith(report.indexBefore)) throw Error("dream-care-index-base-changed");
    for (const reference of report.references) {
      if (!/^memory\/references\/care-[a-z0-9-]+\.md$/u.test(reference.path) || careHash(reference.content) !== reference.sha256) throw Error("dream-care-reference-receipt-invalid");
      writeDreamAtomic(join(workspace, reference.path), reference.content, { immutable: true });
      if (!report.applied.includes(reference.path)) report.applied.push(reference.path);
      save();
    }
    if (!current.includes(report.suffix)) {
      if (report.state === "appending") { report.state = "unknown"; report.reason = "index-append-outcome-unknown"; save(); return { state: report.state, reason: report.reason, files: report.applied }; }
      report.state = "appending"; save();
      const bytes = Buffer.from(report.suffix);
      if (writeSync(fd, bytes) !== bytes.length) { report.state = "unknown"; throw Error("dream-care-partial-index-append"); }
      fsyncSync(fd);
    }
    const named = statSync(index);
    if (named.ino !== inode.ino || named.dev !== inode.dev || !readDreamRegular(index, 32 * 1024).toString("utf8").includes(report.suffix)) { report.state = "unknown"; throw Error("dream-care-index-replaced-during-append"); }
    if (!report.applied.includes("MEMORY.md")) report.applied.push("MEMORY.md");
    report.state = "published"; save();
    return { state: report.state, files: report.applied, draftCommit: report.draftCommit };
  } catch (error) {
    if (report.state !== "unknown") report.state = "refused";
    report.reason = error.message; save();
    return { state: report.state, reason: report.reason, files: report.applied };
  } finally { if (fd !== undefined) closeSync(fd); lease.release(); }
}
