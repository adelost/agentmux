#!/usr/bin/env node
// Nightly repo hygiene, read-only: decides every stale thing in every repo
// touched today with policies/repo-hygiene.mjs and writes what it would do.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listAgents } from "../cli/config.mjs";
import { runtimeAgentsPath } from "../core/runtime-defaults.mjs";
import { loadRuntimeEnv } from "../core/runtime-env.mjs";
import { commonDirOf, mainWorktreeOf, paneDirs, withChildDirs } from "../core/repo-hygiene-facts.mjs";
import { ledgerEntries, reviewRepo } from "../core/repo-hygiene-janitor.mjs";
import { redCount, renderReport, withOpenNowNote } from "../core/repo-hygiene-report.mjs";

const USAGE = "Usage: janitor.mjs [--repo PATH]... [--state-dir PATH]\n"
  + "  Without --repo: every repo under the configured agent dirs and every pane's cwd.";

function parseArgs(argv) {
  const options = { repos: [], stateDir: process.env.AMUX_JANITOR_DIR || join(homedir(), ".agentmux", "janitor") };
  for (let index = 0; index < argv.length; index += 2) {
    const [name, value] = [argv[index], argv[index + 1]];
    if (!value || value.startsWith("--")) throw new Error(USAGE);
    if (name === "--repo") options.repos.push(value);
    else if (name === "--state-dir") options.stateDir = value;
    else throw new Error(USAGE);
  }
  return options;
}

const localDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const readJson = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {});
const firstLine = (error) => (error.stderr?.toString().trim() || error.message).split("\n")[0];
const writeAtomic = (path, text) => { writeFileSync(`${path}.tmp`, text); renameSync(`${path}.tmp`, path); };

function readPanes(warnings) {
  const socket = process.env.TMUX_SOCKET;
  if (!socket) {
    warnings.push("TMUX_SOCKET is not set, so no pane counts as touching a repo tonight");
    return [];
  }
  try {
    return paneDirs(socket).map((dir) => ({ dir, common: commonDirOf(dir) }));
  } catch (error) {
    warnings.push(`pane cwds unreadable (${error.message.split("\n")[0]}), so no pane counts as touching a repo tonight`);
    return [];
  }
}

function reposToReview(options, panes) {
  if (options.repos.length) {
    return options.repos.map((path) => commonDirOf(path) ?? (() => { throw new Error(`not a git repo: ${path}`); })());
  }
  const dirs = listAgents(runtimeAgentsPath()).flatMap(({ dir }) => withChildDirs(dir));
  return [...dirs.map(commonDirOf), ...panes.map(({ common }) => common)];
}

function noteRedOnOpenNow(review, { today, reportPath }) {
  const red = redCount(review);
  if (red === 0 || review.skipped || review.error) return;
  const ledger = join(mainWorktreeOf(review.common), ".agents/0/TASKS.md");
  if (!existsSync(ledger)) return;
  const updated = withOpenNowNote(readFileSync(ledger, "utf8"), { today, red, reportPath });
  if (updated !== null) writeAtomic(ledger, updated);
}

function main() {
  loadRuntimeEnv({ packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), "..") });
  const options = parseArgs(process.argv.slice(2));
  const started = new Date();
  const today = localDate(started);
  const sinceMs = new Date(started.getFullYear(), started.getMonth(), started.getDate()).getTime();
  const warnings = [];
  const panes = readPanes(warnings);
  const commons = [...new Set(reposToReview(options, panes).filter(Boolean))].sort();
  mkdirSync(join(options.stateDir, "reports"), { recursive: true });
  const seenPath = join(options.stateDir, "closed-rows-first-seen.json");
  const ledgerPath = join(options.stateDir, "ledger.jsonl");
  const reportPath = join(options.stateDir, "reports", `${today}.md`);
  const firstSeen = readJson(seenPath);
  const reviewedOrigins = new Set();
  const reviews = commons.map((common) => {
    try {
      return reviewRepo({ common, panes, now: started.getTime(), sinceMs, today, firstSeen, reviewedOrigins });
    } catch (error) {
      return { common, error: firstLine(error) };
    }
  });
  const entriesByRepo = new Map(reviews.map((review) => [review.common,
    ledgerEntries({ repo: review.common, decisions: review.decisions ?? [], at: started.toISOString() })]));
  const entries = [...entriesByRepo.values()].flat();
  if (entries.length) appendFileSync(ledgerPath, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
  const seen = Object.fromEntries(Object.entries(firstSeen).filter(([key]) => !reviews.some((review) => review.seen && key.startsWith(`${review.common}#`))));
  writeAtomic(seenPath, `${JSON.stringify(Object.assign(seen, ...reviews.map((review) => review.seen ?? {})), null, 2)}\n`);
  writeAtomic(reportPath, renderReport({ startedAt: `${today} ${started.toTimeString().slice(0, 5)}`, reviews, entriesByRepo, ledgerPath, warnings }));
  for (const review of reviews) noteRedOnOpenNow(review, { today, reportPath });
  const red = reviews.reduce((sum, review) => sum + redCount(review), 0);
  console.log(`janitor: ${reviews.filter((review) => !review.skipped).length} repos reviewed, ${entries.length} would-actions, ${red} red; report ${reportPath}`);
}

main();
