/**
 * WHAT: Reports short-lived tests and frequently rewritten source files from git history.
 * WHY: Keeps code and test churn visible without turning context-dependent change into a merge gate.
 */

import { execFileSync } from "child_process";
import { resolve } from "path";

const DAY_MS = 86_400_000;
const DEFAULT_DAYS = 14;
const DEFAULT_LIMIT = 10;
const DEFAULT_MIN_COMMITS = 3;
const COMMIT_MARKER = "AMUX_CHURN_COMMIT";
const CODE_EXTENSIONS = new Set([
  ".c", ".cc", ".cpp", ".css", ".go", ".h", ".hpp", ".html", ".java",
  ".js", ".jsx", ".kt", ".kts", ".mjs", ".php", ".py", ".rb", ".rs",
  ".scss", ".sh", ".sql", ".svelte", ".swift", ".ts", ".tsx", ".vue",
]);

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, "-c", "core.quotePath=false", ...args], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
}

function repoRoot(path) {
  try {
    return resolve(git(resolve(path), ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(`amux churn: '${path}' is not inside a git repository`);
  }
}

function positiveInteger(value, name, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`amux churn: ${name} must be a positive integer`);
  return parsed;
}

function extension(path) {
  const name = path.split("/").at(-1) || "";
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

function isCodePath(path) {
  return CODE_EXTENSIONS.has(extension(path));
}

function isTestPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) || "";
  return /(^|\/)(test|tests|__tests__)(\/|$)/.test(normalized)
    || /\.(test|spec)\.[^.]+$/.test(name)
    || /^(test_.*|.*_test)\.py$/.test(name);
}

function testNames(line) {
  const names = [];
  for (const match of line.matchAll(/\b(?:test|it|unit|component|scenario)\s*\(\s*["'`]([^"'`]+)["'`]/g)) names.push(match[1]);
  const python = line.match(/^\s*def\s+(test_[A-Za-z0-9_]+)\s*\(/);
  if (python) names.push(python[1]);
  return names;
}

function patchPath(line) {
  let value = line.slice(4).trim();
  if (value === "/dev/null") return null;
  if (value.startsWith('"') && value.endsWith('"')) {
    try { value = JSON.parse(value); } catch {}
  }
  return value.replace(/^[ab]\//, "");
}

function patchRecords(output) {
  const records = new Map();
  let commit = null;
  let committedAt = 0;
  let oldPath = null;
  let newPath = null;
  let oldLine = 0;
  let newLine = 0;
  const record = () => {
    const path = oldPath || newPath;
    if (!commit || !path) return null;
    const key = `${commit}\0${path}`;
    if (!records.has(key)) records.set(key, {
      commit, committedAt, path, deleted: false, addedNames: new Set(), removed: [],
    });
    return records.get(key);
  };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(`${COMMIT_MARKER}\t`)) {
      [, commit, committedAt] = line.split("\t");
      committedAt = Number(committedAt) * 1000;
      oldPath = null;
      newPath = null;
      continue;
    }
    if (line.startsWith("--- ")) { oldPath = patchPath(line); continue; }
    if (line.startsWith("+++ ")) {
      newPath = patchPath(line);
      const current = record();
      if (current && !newPath) current.deleted = true;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); continue; }
    const current = record();
    if (!current || !isTestPath(current.path)) continue;
    if (line.startsWith("-") && !line.startsWith("---")) {
      for (const name of testNames(line.slice(1))) current.removed.push({ name, line: oldLine });
      oldLine += 1;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      for (const name of testNames(line.slice(1))) current.addedNames.add(name);
      newLine += 1;
    }
  }
  return [...records.values()];
}

function lineBirthTime(root, record, line) {
  try {
    const output = git(root, ["blame", "--line-porcelain", "-L", `${line},${line}`, `${record.commit}^`, "--", record.path]);
    const match = output.match(/^committer-time (\d+)$/m);
    return match ? Number(match[1]) * 1000 : null;
  } catch {
    return null;
  }
}

function fileBirthTime(root, path) {
  try {
    const output = git(root, ["log", "--follow", "--diff-filter=A", "--format=%ct", "--reverse", "--", path]);
    const value = Number(output.split(/\r?\n/).find(Boolean));
    return Number.isFinite(value) ? value * 1000 : null;
  } catch {
    return null;
  }
}

function lifespanDays(bornAt, diedAt) {
  if (!Number.isFinite(bornAt) || diedAt < bornAt) return null;
  return Math.max(0, Math.round((diedAt - bornAt) / DAY_MS));
}

function youngTestEvents(root, records, youngDays) {
  const events = [];
  for (const record of records) {
    if (record.deleted) {
      const days = lifespanDays(fileBirthTime(root, record.path), record.committedAt);
      if (days !== null && days <= youngDays) events.push({
        type: "file", path: record.path, name: null, action: "deleted", days, committedAt: record.committedAt,
      });
      continue;
    }
    for (const removed of record.removed) {
      const days = lifespanDays(lineBirthTime(root, record, removed.line), record.committedAt);
      if (days === null || days > youngDays) continue;
      events.push({
        type: "test", path: record.path, name: removed.name,
        action: record.addedNames.has(removed.name) ? "rewritten" : "removed",
        days, committedAt: record.committedAt,
      });
    }
  }
  const latest = new Map();
  for (const event of events) {
    const key = `${event.type}\0${event.path}\0${event.name || ""}`;
    if (!latest.has(key) || latest.get(key).committedAt < event.committedAt) latest.set(key, event);
  }
  return [...latest.values()].sort((a, b) => b.committedAt - a.committedAt || a.path.localeCompare(b.path));
}

function hotspotRows(root, sinceIso, days, minCommits) {
  const output = git(root, ["log", `--since=${sinceIso}`, "--no-merges", `--format=${COMMIT_MARKER}\t%H`, "--name-only"]);
  const commitsByPath = new Map();
  let commit = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(`${COMMIT_MARKER}\t`)) { commit = line.split("\t")[1]; continue; }
    const path = line.trim();
    if (!commit || !path || !isCodePath(path)) continue;
    if (!commitsByPath.has(path)) commitsByPath.set(path, new Set());
    commitsByPath.get(path).add(commit);
  }
  return [...commitsByPath].map(([path, commits]) => ({ path, commits: commits.size, days, test: isTestPath(path) }))
    .filter((row) => row.commits >= minCommits)
    .sort((a, b) => b.commits - a.commits || a.path.localeCompare(b.path));
}

/**
 * WHAT: Collects young-test and rewrite-hotspot signals from one repository's immutable git history.
 * WHY: Keeps churn analysis deterministic and read-only for any local checkout.
 */
export function analyzeChurn(path, options = {}) {
  const root = repoRoot(path);
  const nowMs = options.nowMs ?? Date.now();
  const days = positiveInteger(options.days, "--days", DEFAULT_DAYS);
  const youngDays = positiveInteger(options.youngDays, "--young-days", DEFAULT_DAYS);
  const limit = positiveInteger(options.limit, "--limit", DEFAULT_LIMIT);
  const minCommits = positiveInteger(options.minCommits, "--min-commits", DEFAULT_MIN_COMMITS);
  const sinceIso = new Date(nowMs - days * DAY_MS).toISOString();
  const patch = git(root, [
    "log", `--since=${sinceIso}`, "--no-merges", `--format=${COMMIT_MARKER}\t%H\t%ct`,
    "-p", "--unified=0", "--no-ext-diff", "--no-color",
  ]);
  return {
    root, days, youngDays, limit,
    young: youngTestEvents(root, patchRecords(patch), youngDays).slice(0, limit),
    hotspots: hotspotRows(root, sinceIso, days, minCommits).slice(0, limit),
  };
}

/**
 * WHAT: Formats churn signals as bounded one-line entries for terminals and digests.
 * WHY: Keeps morning visibility compact without describing churn as a defect.
 */
export function formatChurnReport(report) {
  const lines = [`amux churn · ${report.days}d · WARN-only · read-only`];
  for (const event of report.young) {
    const subject = event.type === "test" ? `${event.path} :: ${event.name}` : event.path;
    lines.push(`YOUNG_${event.type.toUpperCase()} lived ${event.days}d · ${event.action} · ${subject} · worth a look`);
  }
  if (!report.young.length) lines.push("YOUNG none");
  for (const row of report.hotspots) {
    lines.push(`HOTSPOT ${row.commits} commits/${row.days}d · ${row.path} · worth a look`);
  }
  if (!report.hotspots.length) lines.push("HOTSPOT none");
  lines.push(`summary: young=${report.young.length} hotspots=${report.hotspots.length} · visibility only, exit 0`);
  return lines.join("\n");
}

function parseArgs(args) {
  const options = {};
  let path = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (["--days", "--young-days", "--limit", "--min-commits"].includes(arg)) {
      const key = { "--days": "days", "--young-days": "youngDays", "--limit": "limit", "--min-commits": "minCommits" }[arg];
      options[key] = args[++index];
    } else if (arg.startsWith("-")) throw new Error(`amux churn: unknown option '${arg}'`);
    else if (path) throw new Error("amux churn: accepts at most one repository path");
    else path = arg;
  }
  return { path: path || process.cwd(), options };
}

/**
 * WHAT: Dispatches the read-only churn report for one CLI argument list.
 * WHY: Keeps warning findings independent from process failure and repository mutation.
 */
export function runChurnCommand(args, output = console.log) {
  const parsed = parseArgs(args);
  if (parsed.help) {
    output("Usage: amux churn [path] [--days N] [--young-days N] [--limit N] [--min-commits N]\n\nWARN-only git history visibility. Findings never fail the command and no repository files are written.");
    return null;
  }
  const report = analyzeChurn(parsed.path, parsed.options);
  output(formatChurnReport(report));
  return report;
}
