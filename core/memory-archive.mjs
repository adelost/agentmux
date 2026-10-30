// Lossless archive of finished daily memory files. The original moves
// byte-for-byte to memory/archive/daily/DATE.md and a stub keeps the old path,
// its summary and pointers to the archive and the Dream digest that covered
// the day. The morning after a verified night the stub carries that night's
// summary, so each finished day reads as a summary (Mattias 2026-10-19). No
// model writes here, so nothing can be lost or paraphrased.

import { createHash } from "crypto";
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  statSync, writeSync,
} from "fs";
import { basename, join } from "path";
import { tryLockDir } from "./dir-lock.mjs";
import { dailyPolicyFor, localDateKey, loadMemoryPolicy } from "./memory-policy.mjs";

const DAILY_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const DREAM_RUN_RE = /^(\d{4}-\d{2}-\d{2})-.+\.md$/;
const ARCHIVE_DIR = "memory/archive/daily";
const STUB_MARKER_RE = /<!-- amux-memory-archived: (\S+) sha256:([0-9a-f]{64}) -->/;
const TEMPLATE_HEADINGS = new Set(["Händelser", "Pågående", "Dokumenterat"]);
const DIGEST_SKIP_HEADINGS = new Set(["Underlag och kontinuitet"]);
const SUMMARY_MAX = 200;
const FALLBACK_SUMMARY = "Arkiverad dagfil";
// Summaries a template writes before anyone fills the day in. They say nothing
// about the day, so the stub summary is taken from its headings instead.
const GENERIC_SUMMARY_RES = [/^\{.*\}$/, /^Daily notes for \d{4}-\d{2}-\d{2}(?:[,.]|$)/];
const LOCK_STALE_MS = 10 * 60_000;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** WHAT: Names a day's archived original. WHY: Keeps readers of a stub from following a pointer to any other file. */
export const archiveRel = (dateKey) => `${ARCHIVE_DIR}/${dateKey}.md`;

/** WHAT: Reads the archive pointer of a stub. WHY: Lets lint and reruns tell an archived day from an unarchived one. */
export function parseArchiveStub(text) {
  const match = String(text).split(/\r?\n/, 5).join("\n").match(STUB_MARKER_RE);
  return match ? { archivePath: match[1], sha256: match[2] } : null;
}

const oneLine = (text) => {
  const clean = String(text).replace(/\s+/g, " ").trim();
  return clean.length > SUMMARY_MAX ? `${clean.slice(0, SUMMARY_MAX - 1)}…` : clean;
};

const summaryLine = (text) => String(text).split(/\r?\n/).slice(0, 5)
  .find((line) => /^> summary:\s*\S/.test(line))?.replace(/^> summary:\s*/, "").trim();

const isGenericSummary = (summary) => GENERIC_SUMMARY_RES.some((re) => re.test(summary));

const headings = (text, skip) => String(text).split(/\r?\n/)
  .filter((line) => line.startsWith("## "))
  .map((line) => line.slice(3).replace(/<!--.*?-->/g, "").trim())
  .filter((heading) => heading && !skip.has(heading));

/** WHAT: Resolves the stub summary. WHY: Keeps a real, searchable one-line summary even for days written without one. */
export function archiveSummary(original, digestTexts = []) {
  const ownText = summaryLine(original);
  if (ownText && !isGenericSummary(ownText)) return oneLine(ownText);
  for (const digest of digestTexts) {
    const found = headings(digest, DIGEST_SKIP_HEADINGS).slice(0, 3);
    if (found.length) return oneLine(found.join("; "));
  }
  const found = headings(original, TEMPLATE_HEADINGS).slice(0, 3);
  if (found.length) return oneLine(found.join("; "));
  return FALLBACK_SUMMARY;
}

/** WHAT: Builds the stub left at the daily path, with the night's summary when there is one. WHY: Keeps links, search and lint working while the full text lives in the archive. */
export function buildArchiveStub({ dateKey, summary, sha, digests = [], nightSummary = "" }) {
  const archive = archiveRel(dateKey);
  const dream = digests.map((path) => ` · Dream: \`${path}\``).join("");
  const night = String(nightSummary).trim();
  return [
    `> summary: ${summary}`,
    `> why: Arkiverad dagfil; hela originalet ligger orört i arkivet.`,
    `<!-- amux-memory-archived: ${archive} sha256:${sha} -->`,
    `# ${dateKey}`,
    ...(night ? ["", night, ""] : []),
    `- Original: \`${archive}\`${dream}`,
  ].join("\n") + "\n";
}

// A Dream run is named after the morning it ran and covers the day before, so
// a day's digest is the first saved run dated after it.
function digestsFor(workspace, dateKey) {
  const dir = join(workspace, "memory", "dream");
  if (!existsSync(dir)) return [];
  const runs = readdirSync(dir).filter((name) => DREAM_RUN_RE.test(name)).sort();
  const covering = runs.map((name) => name.match(DREAM_RUN_RE)[1]).find((runDate) => runDate > dateKey);
  return covering ? runs.filter((name) => name.startsWith(`${covering}-`)).map((name) => `memory/dream/${name}`) : [];
}

const lineCount = (text) => {
  const lines = String(text).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
};

const openTodos = (text) => String(text).split(/\r?\n/).filter((line) => line.startsWith("- [ ] ")).length;

/** WHAT: Collects the finished daily files the archive may move, and stubs still carrying a template summary. WHY: Keeps today's, yesterday's, already archived, short and todo-carrying days where they are, and lets earlier stubs get a real summary. */
export function planMemoryArchive(workspace, { now = new Date(), policy: supplied, max } = {}) {
  const policy = supplied || loadMemoryPolicy(workspace);
  const memoryDir = join(workspace, "memory");
  const limit = Number.isInteger(max) && max > 0 ? max : policy.archiveMaxPerRun;
  const eligible = [];
  const blocked = [];
  const rebuild = [];
  if (!existsSync(memoryDir)) return { eligible, remaining: 0, blocked, rebuild, limit };
  for (const name of readdirSync(memoryDir).sort()) {
    const dateKey = name.match(DAILY_RE)?.[1];
    if (!dateKey) continue;
    // Today is still being written; yesterday leaves with its night (archiveNightDay).
    if (dailyPolicyFor(dateKey, policy, now).protected) continue;
    const path = join(memoryDir, name);
    const text = readFileSync(path, "utf-8");
    const stub = parseArchiveStub(text);
    if (stub) {
      if (hasGenericStubSummary(text)) rebuild.push({ dateKey, path, ...stub });
      continue;
    }
    const lines = lineCount(text);
    if (lines <= policy.oldDailyMaxLines) continue;
    const todos = openTodos(text);
    const row = { dateKey, path, lines };
    if (todos) blocked.push({ ...row, reason: `${todos} open todo(s)` });
    else eligible.push(row);
  }
  return { eligible: eligible.slice(0, limit), remaining: Math.max(0, eligible.length - limit), blocked, rebuild, limit };
}

const hasGenericStubSummary = (stub) => {
  const summary = summaryLine(stub) ?? "";
  return summary === FALLBACK_SUMMARY || isGenericSummary(summary);
};

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

function stubFor(workspace, dateKey, original, sha, nightSummary) {
  const digests = digestsFor(workspace, dateKey);
  const digestTexts = digests.map((path) => readFileSync(join(workspace, path), "utf-8"));
  return buildArchiveStub({ dateKey, sha, digests, nightSummary, summary: archiveSummary(original.toString("utf-8"), digestTexts) });
}

function archiveOne(workspace, row, { nightSummary } = {}) {
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
  const stub = stubFor(workspace, row.dateKey, original, sha, nightSummary);
  if (sha256(readFileSync(row.path)) !== sha) throw new Error("daily file changed during archive; left as is");
  writeDurable(row.path, stub, mode);
  return { ...row, archivePath: archiveRel(row.dateKey), sha256: sha, stubLines: lineCount(stub) };
}

/** WHAT: Rewrites a stub from its archived original. WHY: Stubs written before template summaries were recognised said nothing about their day. */
function rebuildOne(workspace, row) {
  const original = readFileSync(join(workspace, row.archivePath));
  if (sha256(original) !== row.sha256) throw new Error(`${row.archivePath} does not match its stub`);
  const stub = stubFor(workspace, row.dateKey, original, row.sha256);
  if (stub === readFileSync(row.path, "utf-8")) return null;
  writeDurable(row.path, stub, statSync(row.path).mode & 0o777);
  return { ...row, summary: summaryLine(stub) };
}

function lockArchive(workspace) {
  mkdirSync(join(workspace, ARCHIVE_DIR), { recursive: true });
  const release = tryLockDir(join(workspace, ARCHIVE_DIR, ".amux-archive.lock"), { staleMs: LOCK_STALE_MS });
  if (!release) throw new Error("memory archive is already running");
  return release;
}

/** WHAT: Turns the day a verified night covered into that night's summary. WHY: Makes each finished day a short summary the morning after, with its full notes one link away. */
export function archiveNightDay(workspace, dateKey, { summary, now = new Date() } = {}) {
  const path = join(workspace, "memory", `${dateKey}.md`);
  if (dateKey >= localDateKey(now)) return { archived: null, reason: "today is still being written" };
  if (!existsSync(path)) return { archived: null, reason: "no daily file" };
  const text = readFileSync(path, "utf-8");
  if (parseArchiveStub(text)) return { archived: null, reason: "already archived" };
  const todos = openTodos(text);
  if (todos) return { archived: null, reason: `${todos} open todo(s)` };
  const release = lockArchive(workspace);
  try {
    return { archived: archiveOne(workspace, { dateKey, path, lines: lineCount(text) }, { nightSummary: summary }) };
  } finally {
    release();
  }
}

/** WHAT: Stores the planned daily files in the archive. WHY: Keeps the daily size rule from being a warning without an actor, losing no byte. */
export function archiveMemory(workspace, { dryRun = true, now = new Date(), max } = {}) {
  const plan = planMemoryArchive(workspace, { now, max });
  if (dryRun || !(plan.eligible.length || plan.rebuild.length)) return { workspace, dryRun, ...plan, archived: [], rebuilt: [], failed: [] };
  const release = lockArchive(workspace);
  const archived = [];
  const rebuilt = [];
  const failed = [];
  try {
    for (const row of plan.eligible) {
      try { archived.push(archiveOne(workspace, row)); }
      catch (error) { failed.push({ ...row, error: error.message }); }
    }
    for (const row of plan.rebuild) {
      try {
        const done = rebuildOne(workspace, row);
        if (done) rebuilt.push(done);
      } catch (error) { failed.push({ ...row, error: error.message }); }
    }
  } finally {
    release();
  }
  return { workspace, dryRun: false, ...plan, archived, rebuilt, failed };
}

/** WHAT: Formats one archive run. WHY: Keeps the nightly log and the CLI on one readable shape. */
export function formatMemoryArchive(result) {
  const verb = result.dryRun ? "would archive" : "archived";
  const count = result.dryRun ? result.eligible.length : result.archived.length;
  const stubs = result.dryRun
    ? `${result.rebuild.length} stub(s) with a template summary`
    : `${result.rebuilt.length} stub summary(ies) rebuilt`;
  const rows = [`Memory archive: ${verb} ${count} daily file(s), ${stubs}, ${result.failed.length} failed, ${result.remaining} left for later runs, ${result.blocked.length} blocked`];
  for (const row of result.dryRun ? result.eligible : result.archived) {
    rows.push(`${result.dryRun ? "PLAN" : "OK"} ${basename(row.path)}: ${row.lines} lines -> ${row.archivePath || archiveRel(row.dateKey)}`);
  }
  for (const row of result.dryRun ? result.rebuild : result.rebuilt) {
    rows.push(`${result.dryRun ? "PLAN" : "OK"} ${basename(row.path)}: stub summary${row.summary ? ` -> ${row.summary}` : ""}`);
  }
  for (const row of result.failed) rows.push(`FAIL ${basename(row.path)}: ${row.error}`);
  for (const row of result.blocked) rows.push(`KEEP ${basename(row.path)}: ${row.reason}`);
  return rows.join("\n");
}
