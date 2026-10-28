// WHAT: Reduces artifact folders unchanged for 2 days to their receipts and deletes the rest.
// WHY: Keeps evidence readable while videos, builds and copies stop filling the SSD that also holds Q:.

import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, join } from "node:path";
import { processPathReferences } from "./process-path-references.mjs";
import { measureTrees } from "./tree-usage.mjs";

const DAY = 86400000;
const OVERFLOW_ROOT = "/mnt/q";
const RECEIPT_MAX_BYTES = 1024 * 1024;
/** WHAT: Names how many days without a change mean a folder's work has stopped. WHY: Keeps bulky evidence only while its row runs. */
export const RETENTION_DAYS = 2;
/** WHAT: Names the file that keeps an artifact folder whole. WHY: Keeps paid or hand-picked output out of retention. */
export const KEEP_MARKER = ".artifact-keep";

// Text up to 1 MB is the receipt. On 2026-10-28 the ledgers linked 117 md and 57 json files in artifacts but 4 images,
// while the small images kept were mostly video frames, 32 GB in 7 days. A file a repository document links to stays
// at any size. Audio and 3D models stay because they may be paid output; the paid music-video folder has a keep marker.
const SMALL_RECEIPTS = new Set([".md", ".json", ".jsonl", ".ndjson", ".log", ".txt", ".yaml", ".yml", ".csv", ".tsv", ".html"]);
const ARTIFACT_LINK = /\.artifacts\/([^\s)|`>"'\]]+)/gu;
const ALWAYS_KEPT = new Set([".mp3", ".wav", ".m4a", ".flac", ".ogg", ".glb", ".gltf", ".fbx", ".obj", ".vrm"]);
const COPIED_TREES = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__"]);

/** WHAT: Checks whether retention keeps a file. WHY: Separates receipts and possibly paid media from regenerable bulk. */
export function isKeptFile(name, bytes) {
  const extension = extname(name).toLowerCase();
  return ALWAYS_KEPT.has(extension) || (SMALL_RECEIPTS.has(extension) && bytes <= RECEIPT_MAX_BYTES);
}

const folders = (path) => readdirSync(path, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(({ name }) => join(path, name));

/** WHAT: Collects the folders retention judges, splitting a folder of several folders into its children. WHY: Keeps one fresh run from holding an old container such as release-row. */
export function artifactUnits(root) {
  if (!existsSync(root)) return [];
  return folders(root).flatMap((folder) => {
    const entries = readdirSync(folder, { withFileTypes: true });
    const container = entries.length > 1 && entries.every((entry) => entry.isDirectory() && !entry.isSymbolicLink());
    return container ? folders(folder) : [folder];
  });
}

/** WHAT: Collects the artifact root and its copies in the earlier Q: overflow folders. WHY: Keeps folders moved before 1.25.406 under the same retention. */
export function artifactRoots({ root = join(homedir(), "lsrc/.artifacts"), overflowRoot = OVERFLOW_ROOT } = {}) {
  const moved = existsSync(overflowRoot) ? readdirSync(overflowRoot).filter((name) => /^wsl-overflow-\d{4}-\d{2}-\d{2}$/u.test(name))
    .map((name) => join(overflowRoot, name, root)).filter(existsSync) : [];
  return [root, ...moved];
}

/** WHAT: Collects the Markdown files at the root and under docs/ of each ~/lsrc repository. WHY: Keeps the ledgers and designs that link evidence in view. */
export function repositoryDocs({ lsrc = join(homedir(), "lsrc") } = {}) {
  if (!existsSync(lsrc)) return [];
  const markdown = (folder, recursive) => readdirSync(folder, { recursive, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => join(entry.parentPath, entry.name));
  return folders(lsrc).filter((repo) => !repo.split("/").at(-1).startsWith(".")).flatMap((repo) =>
    [...markdown(repo, false), ...(existsSync(join(repo, "docs")) ? markdown(join(repo, "docs"), true) : [])]);
}

/** WHAT: Collects the artifact paths documents link to, resolved in every artifact root. WHY: Keeps a ledger's or design's linked file after its folder is pruned. */
export function linkedArtifacts({ roots, docs }) {
  const linked = new Set();
  for (const doc of docs) {
    for (const [, link] of readFileSync(doc, "utf8").matchAll(ARTIFACT_LINK)) {
      for (const root of roots) linked.add(join(root, link.replace(/[.,:;]+$/u, "")));
    }
  }
  return linked;
}

/** WHAT: Collects the files and copied dependency trees retention deletes in one folder. WHY: Keeps the plan and the deletion on one rule. */
export function prunableEntries(unit, linked = new Set()) {
  const files = [], trees = [];
  let bytes = 0, keptFiles = 0;
  const pending = [{ path: unit, copied: false }];
  while (pending.length) {
    const { path: folder, copied } = pending.pop();
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        const tree = !copied && COPIED_TREES.has(entry.name);
        if (tree) trees.push(path);
        pending.push({ path, copied: copied || tree });
      } else if (entry.isFile()) {
        const size = lstatSync(path).size;
        if (!copied && (isKeptFile(entry.name, size) || linked.has(path))) keptFiles++;
        else { bytes += size; if (!copied) files.push(path); }
      }
    }
  }
  return { files, trees, bytes, keptFiles };
}

/** WHAT: Names why a folder stays whole, or nothing when retention may prune it. WHY: Keeps recent, open, marked or locked evidence intact. */
function heldReasons(path, tree, holders, { nowMs, days }) {
  const reasons = [];
  if (!tree || tree.error) reasons.push(`unreadable folder: ${tree?.error ?? "not measured"}`);
  else if (nowMs - tree.newestModifiedMs < days * DAY) reasons.push(`modified within ${days} days`);
  if (tree?.browserProfile) reasons.push("holds a browser profile");
  if (tree?.lockedFolders) reasons.push("holds folders this user cannot change");
  if (existsSync(join(path, KEEP_MARKER))) reasons.push(`marked with ${KEEP_MARKER}`);
  if (holders.errors.length) reasons.push("unreadable process evidence");
  if ((holders.holders?.[path] ?? []).length) reasons.push("process cwd, fd or mapping inside");
  return reasons;
}

/** WHAT: Collects artifact folders unchanged for the retention period that hold something to delete. WHY: Keeps the dry run and the deletion on the same candidates. */
export function planArtifactRetention({ roots = artifactRoots(), docs = repositoryDocs(), nowMs = Date.now(), days = RETENTION_DAYS,
  measure = measureTrees, references = processPathReferences } = {}) {
  const units = roots.flatMap(artifactUnits), linked = linkedArtifacts({ roots, docs });
  const usage = measure(units), safety = references(units);
  const candidates = [], skipped = [];
  for (const path of units) {
    const reasons = heldReasons(path, usage[path], safety, { nowMs, days });
    if (reasons.length) { skipped.push({ path, reasons }); continue; }
    let doomed;
    try { doomed = prunableEntries(path, linked); } catch (error) { skipped.push({ path, reasons: [`unreadable folder: ${error.message}`] }); continue; }
    if (doomed.files.length || doomed.trees.length) candidates.push({ path, ...usage[path], pruneBytes: doomed.bytes, keptFiles: doomed.keptFiles });
  }
  return { candidates, skipped, errors: safety.errors, linked, pruneBytes: candidates.reduce((sum, { pruneBytes }) => sum + pruneBytes, 0) };
}

/** WHAT: Stores one retention receipt durably. WHY: Keeps df before and after each folder when a long run is interrupted. */
function journal(entry, path) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try { appendFileSync(fd, `${JSON.stringify(entry)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/** WHAT: Stores a note in a pruned folder saying what went and why. WHY: Keeps a missing video explainable without the journal. */
function notePruned(folder, entry, days) {
  const note = join(folder, "PRUNED.md");
  if (!existsSync(note)) appendFileSync(note, `# Pruned by the agentmux disk cleanup\n\nThe folder was unchanged for ${days} days, so its work had stopped. Kept: text files up to 1 MB, audio, 3D models and files a repository document links to.\n`
    + `A folder holding \`${KEEP_MARKER}\` is never pruned.\n\n`);
  appendFileSync(note, `- ${entry.at.slice(0, 10)}: deleted ${entry.deletedFiles} files plus ${entry.deletedTrees} node_modules, .git or venv folders, ${(entry.deletedBytes / 1e9).toFixed(2)} GB; kept ${entry.keptFiles} files.\n`);
}

/** WHAT: Dispatches the deletions for planned folders after checking each again. WHY: Keeps a folder that changed or opened since planning whole. */
export function pruneArtifacts(plan, { nowMs = Date.now(), days = RETENTION_DAYS, sampleDisk, measure = measureTrees, references = processPathReferences,
  journalPath = join(homedir(), ".agentmux", "artifact-retention.jsonl") } = {}) {
  const results = [];
  if (plan.errors.length) return results;
  for (const planned of plan.candidates) {
    const entry = { at: new Date(nowMs).toISOString(), path: planned.path, mode: "skipped" };
    const reasons = heldReasons(planned.path, measure([planned.path])[planned.path], references([planned.path]), { nowMs, days });
    if (reasons.length) { journal({ ...entry, reasons }, journalPath); results.push({ ...entry, reasons }); continue; }
    entry.before = sampleDisk();
    try {
      const doomed = prunableEntries(planned.path, plan.linked);
      Object.assign(entry, { deletedBytes: doomed.bytes, deletedFiles: doomed.files.length, deletedTrees: doomed.trees.length, keptFiles: doomed.keptFiles });
      for (const file of doomed.files) rmSync(file, { force: true });
      for (const tree of doomed.trees) rmSync(tree, { recursive: true, force: true });
      execFileSync("find", [planned.path, "-mindepth", "1", "-depth", "-type", "d", "-empty", "-delete"], { stdio: "ignore" });
      entry.mode = "pruned";
      notePruned(planned.path, entry, days);
    } catch (error) { entry.mode = "refused"; entry.error = (error.stderr?.toString().trim() || error.message).slice(0, 500); }
    entry.after = sampleDisk(); entry.freedBytes = entry.after.availableBytes - entry.before.availableBytes;
    journal(entry, journalPath); results.push(entry);
    if (entry.mode === "refused") break;
  }
  return results;
}
