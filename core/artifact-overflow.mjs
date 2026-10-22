import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, statfsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { processPathReferences } from "./process-path-references.mjs";
import { measureTrees } from "./tree-usage.mjs";

const DAY = 86400000;
const OVERFLOW_ROOT = "/mnt/q";

/** WHAT: Names the dated overflow folder on Q:. WHY: Keeps each night's moves and their manifest together, under the original absolute paths. */
export const overflowFolder = (nowMs, root = OVERFLOW_ROOT) => join(root, `wsl-overflow-${new Date(nowMs).toISOString().slice(0, 10)}`);

/** WHAT: Reads free bytes on the overflow drive. WHY: Refuses a move that would not fit instead of failing halfway through a folder. */
function overflowFreeBytes(root) {
  const stats = statfsSync(root);
  return stats.bavail * stats.bsize;
}

// Age is the newest mtime in the folder. ctime is no evidence of use here: one metadata sweep on
// 2026-10-21 19:26 set the ctime of 1079 top-level folders at once.
/** WHAT: Collects artifact folders unmodified for the retention period and unused by any process. WHY: Keeps recent or open output on the root disk. */
export function planArtifactOverflow({ root = join(homedir(), "lsrc/.artifacts"), nowMs = Date.now(), days = 14,
  overflowRoot = OVERFLOW_ROOT, measure = measureTrees, references = processPathReferences, freeBytes = overflowFreeBytes } = {}) {
  const folders = existsSync(root) ? readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map(({ name }) => join(root, name)) : [];
  const usage = measure(folders), safety = references(folders);
  const candidates = [], skipped = [], errors = [...safety.errors];
  for (const path of folders) {
    const tree = usage[path], reasons = [];
    if (!tree || tree.error) reasons.push(`unreadable folder: ${tree?.error ?? "not measured"}`);
    else if (nowMs - tree.newestModifiedMs < days * DAY) reasons.push(`modified within ${days} days`);
    if (tree?.browserProfile) reasons.push("holds a browser profile");
    if (safety.errors.length) reasons.push("unreadable process evidence");
    if ((safety.holders?.[path] ?? []).length) reasons.push("process cwd, fd or mapping inside");
    if (reasons.length) skipped.push({ path, reasons }); else candidates.push({ path, ...tree });
  }
  const bytes = candidates.reduce((sum, { bytes: size }) => sum + size, 0);
  let available = null;
  try { available = freeBytes(overflowRoot); } catch (error) { errors.push({ path: overflowRoot, error: error.message }); }
  if (available !== null && available < bytes * 1.1) errors.push({ path: overflowRoot, error: "not enough free space on the overflow drive" });
  return { destination: overflowFolder(nowMs, overflowRoot), candidates, skipped, errors, bytes, overflowFreeBytes: available };
}

/** WHAT: Appends one manifest row, creating the header once. WHY: Lets a person find and move back every folder without the agent's logs. */
function manifestRow(destination, row) {
  const path = join(destination, "MANIFEST.md");
  mkdirSync(destination, { recursive: true });
  if (!existsSync(path)) appendFileSync(path, [`# WSL overflow ${destination.slice(-10)}`, "",
    "Moved off the WSL root disk by the agentmux disk cleanup: folders in ~/lsrc/.artifacts unchanged for 14 days",
    "and open in no process. Nothing listed here was deleted. Each folder keeps its original absolute path under",
    "this folder. Move one back with:", "", "    rsync -rlt --remove-source-files <this folder><original path>/ <original path>/", "",
    "| Original path | Bytes | Files | Last change | Result |", "|---|---:|---:|---|---|", ""].join("\n"));
  const fd = openSync(path, "a");
  try { appendFileSync(fd, `${row}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/** WHAT: Stores one move receipt durably. WHY: Keeps df before and after each folder when the long move is interrupted. */
function journal(entry, path = join(homedir(), ".agentmux", "artifact-overflow.jsonl")) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, "a", 0o600);
  try { appendFileSync(fd, `${JSON.stringify(entry)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
}

/** WHAT: Dispatches planned folders to Q: with rsync, which deletes each source file after its checked copy. WHY: Keeps every artifact while freeing the root disk. */
export function moveArtifacts(plan, { nowMs = Date.now(), sampleDisk, references = processPathReferences, measure = measureTrees,
  days = 14, run = (args) => execFileSync("rsync", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) } = {}) {
  const results = [];
  if (plan.errors.length) return results;
  for (const planned of plan.candidates) {
    const fresh = measure([planned.path])[planned.path], holders = references([planned.path]);
    const entry = { at: new Date(nowMs).toISOString(), path: planned.path, bytes: fresh?.bytes, files: fresh?.files,
      destination: join(plan.destination, planned.path), mode: "skipped" };
    if (!fresh || fresh.error || fresh.browserProfile || nowMs - fresh.newestModifiedMs < days * DAY || holders.errors.length
      || (holders.holders?.[planned.path] ?? []).length) { journal(entry); results.push(entry); continue; }
    entry.before = sampleDisk(); entry.mode = "attempting"; journal({ ...entry });
    try {
      mkdirSync(entry.destination, { recursive: true });
      run(["-rlt", "--remove-source-files", `${planned.path}/`, `${entry.destination}/`]);
      execFileSync("find", [planned.path, "-depth", "-type", "d", "-empty", "-delete"], { stdio: "ignore" });
      entry.mode = existsSync(planned.path) && lstatSync(planned.path).isDirectory() ? "partial" : "moved";
    } catch (error) { entry.mode = "refused"; entry.error = (error.stderr?.toString().trim() || error.message).slice(0, 500); }
    entry.after = sampleDisk(); entry.freedBytes = entry.after.availableBytes - entry.before.availableBytes;
    manifestRow(plan.destination, `| ${planned.path} | ${entry.bytes} | ${entry.files} | ${new Date(fresh.newestModifiedMs).toISOString().slice(0, 10)} | ${entry.mode} |`);
    journal(entry); results.push(entry);
    if (entry.mode === "refused") break;
  }
  return results;
}
