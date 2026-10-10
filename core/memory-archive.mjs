// Lossless archive of old daily memory files: the deterministic actor behind
// the old-band size rule. The original moves byte-for-byte to
// memory/archive/daily/DATE.md and a five-line stub keeps the old path, its
// summary and pointers to the archive and that night's Dream digest. No model
// writes anything, so nothing can be lost or paraphrased.

import { createHash } from "crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  statSync, writeSync,
} from "fs";
import { basename, join } from "path";
import { tryLockDir } from "./dir-lock.mjs";
import { dailyPolicyFor, loadMemoryPolicy } from "./memory-policy.mjs";

const DAILY_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const ARCHIVE_DIR = "memory/archive/daily";
const STUB_MARKER_RE = /<!-- amux-memory-archived: (\S+) sha256:([0-9a-f]{64}) -->/;
const TEMPLATE_HEADINGS = new Set(["Händelser", "Pågående", "Dokumenterat"]);
const DIGEST_SKIP_HEADINGS = new Set(["Underlag och kontinuitet"]);
const SUMMARY_MAX = 200;
const LOCK_STALE_MS = 10 * 60_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const archiveRel = (dateKey) => `${ARCHIVE_DIR}/${dateKey}.md`;

/** WHAT: Reads the archive pointer of a stub. WHY: Lets lint and reruns tell an archived day from an unarchived one. */
export function parseArchiveStub(text) {
  const match = String(text).split(/\r?\n/, 5).join("\n").match(STUB_MARKER_RE);
  return match ? { archivePath: match[1], sha256: match[2] } : null;
}

const oneLine = (text) => {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX - 1)}…` : clean;
};

const headings = (text, skip) => String(text).split(/\r?\n/)
  .filter((line) => line.startsWith("## "))
  .map((line) => line.slice(3).replace(/<!--.*?-->/g, "").trim())
  .filter((heading) => heading && !skip.has(heading));

/** WHAT: Resolves the stub summary. WHY: Keeps a real, searchable one-line summary even for days written without one. */
export function archiveSummary(original, digestTexts = []) {
  const own = String(original).split(/\r?\n/).slice(0, 5)
    .find((line) => /^> summary:\s*\S/.test(line));
  const ownText = own?.replace(/^> summary:\s*/, "").trim();
  if (ownText && !/^\{.*\}$/.test(ownText)) return oneLine(ownText);
  for (const digest of digestTexts) {
    const found = headings(digest, DIGEST_SKIP_HEADINGS).slice(0, 3);
    if (found.length) return oneLine(found.join("; "));
  }
  const found = headings(original, TEMPLATE_HEADINGS).slice(0, 3);
  if (found.length) return oneLine(found.join("; "));
  return "Arkiverad dagfil";
}

/** WHAT: Builds the five-line stub left at the daily path. WHY: Keeps links, search and lint working while the full text lives in the archive. */
export function buildArchiveStub({ dateKey, summary, sha, digests = [] }) {
  const archive = archiveRel(dateKey);
  const dream = digests.map((path) => ` · Dream: \`${path}\``).join("");
  return [
    `> summary: ${summary}`,
    `> why: Arkiverad dagfil; hela originalet ligger orört i arkivet.`,
    `<!-- amux-memory-archived: ${archive} sha256:${sha} -->`,
    `# ${dateKey}`,
    `- Original: \`${archive}\`${dream}`,
  ].join("\n") + "\n";
}

function digestsFor(workspace, dateKey) {
  const dir = join(workspace, "memory", "dream");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.startsWith(`${dateKey}-`) && name.endsWith(".md"))
    .sort()
    .map((name) => `memory/dream/${name}`);
}

const lineCount = (text) => {
  const lines = String(text).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
};

/** WHAT: Collects the old daily files the archive may move. WHY: Keeps today's, recent, already archived and todo-carrying days where they are. */
export function planMemoryArchive(workspace, { now = new Date(), policy: supplied, max } = {}) {
  const policy = supplied || loadMemoryPolicy(workspace);
  const memoryDir = join(workspace, "memory");
  const limit = Number.isInteger(max) && max > 0 ? max : policy.archiveMaxPerRun;
  const eligible = [];
  const blocked = [];
  if (!existsSync(memoryDir)) return { eligible, remaining: 0, blocked, limit };
  for (const name of readdirSync(memoryDir).sort()) {
    const dateKey = name.match(DAILY_RE)?.[1];
    if (!dateKey) continue;
    const rule = dailyPolicyFor(dateKey, policy, now);
    if (rule.protected || rule.maxLines !== policy.oldDailyMaxLines) continue;
    const path = join(memoryDir, name);
    const text = readFileSync(path, "utf-8");
    if (parseArchiveStub(text)) continue;
    const lines = lineCount(text);
    if (lines <= rule.maxLines) continue;
    const todos = text.split(/\r?\n/).filter((line) => line.startsWith("- [ ] ")).length;
    const row = { dateKey, path, lines };
    if (todos) blocked.push({ ...row, reason: `${todos} open todo(s)` });
    else eligible.push(row);
  }
  return { eligible: eligible.slice(0, limit), remaining: Math.max(0, eligible.length - limit), blocked, limit };
}

function writeDurable(path, bytes, mode) {
  const tmp = `${path}.amux-archive-${process.pid}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function archiveOne(workspace, row) {
  const original = readFileSync(row.path);
  const mode = statSync(row.path).mode & 0o777;
  const sha = sha256(original);
  const target = join(workspace, archiveRel(row.dateKey));
  if (existsSync(target)) {
    // A rerun after an interrupted stub write may find its own copy; anything
    // else is a different file and is never overwritten.
    if (sha256(readFileSync(target)) !== sha) throw new Error(`${archiveRel(row.dateKey)} exists with different content`);
  } else {
    writeDurable(target, original, mode);
  }
  if (sha256(readFileSync(target)) !== sha) throw new Error(`${archiveRel(row.dateKey)} does not match the original`);
  const digests = digestsFor(workspace, row.dateKey);
  const digestTexts = digests.map((path) => readFileSync(join(workspace, path), "utf-8"));
  const stub = buildArchiveStub({
    dateKey: row.dateKey, sha, digests,
    summary: archiveSummary(original.toString("utf-8"), digestTexts),
  });
  if (sha256(readFileSync(row.path)) !== sha) throw new Error("daily file changed during archive; left as is");
  writeDurable(row.path, stub, mode);
  return { ...row, archivePath: archiveRel(row.dateKey), sha256: sha, stubLines: lineCount(stub) };
}

/** WHAT: Stores the planned daily files in the archive. WHY: Keeps the old-band size rule from being a warning without an actor, losing no byte. */
export function archiveMemory(workspace, { dryRun = true, now = new Date(), max } = {}) {
  const plan = planMemoryArchive(workspace, { now, max });
  if (dryRun || !plan.eligible.length) return { workspace, dryRun, ...plan, archived: [], failed: [] };
  mkdirSync(join(workspace, ARCHIVE_DIR), { recursive: true });
  const release = tryLockDir(join(workspace, ARCHIVE_DIR, ".amux-archive.lock"), { staleMs: LOCK_STALE_MS });
  if (!release) throw new Error("memory archive is already running");
  const archived = [];
  const failed = [];
  try {
    for (const row of plan.eligible) {
      try { archived.push(archiveOne(workspace, row)); }
      catch (error) { failed.push({ ...row, error: error.message }); }
    }
  } finally {
    release();
  }
  return { workspace, dryRun: false, ...plan, archived, failed };
}

/** WHAT: Formats one archive run. WHY: Keeps the nightly log and the CLI on one readable shape. */
export function formatMemoryArchive(result) {
  const verb = result.dryRun ? "would archive" : "archived";
  const count = result.dryRun ? result.eligible.length : result.archived.length;
  const rows = [`Memory archive: ${verb} ${count} daily file(s), ${result.failed.length} failed, ${result.remaining} left for later runs, ${result.blocked.length} blocked`];
  for (const row of result.dryRun ? result.eligible : result.archived) {
    rows.push(`${result.dryRun ? "PLAN" : "OK"} ${basename(row.path)}: ${row.lines} lines -> ${row.archivePath || archiveRel(row.dateKey)}`);
  }
  for (const row of result.failed) rows.push(`FAIL ${basename(row.path)}: ${row.error}`);
  for (const row of result.blocked) rows.push(`KEEP ${basename(row.path)}: ${row.reason}`);
  return rows.join("\n");
}
