// Warns an agent that briefs a pane on a project the pane has never talked about.
// On 19 Oct lsrc:0 staffed ai:0-2 on Cutkit and Haunt, where none of them had a
// single reply, while skyvw:0 and lsrc:1 had hundreds; a staffing rule alone failed.
// The warning never blocks: the sender decides, now knowing who has the history.

import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultAskLedgerPath } from "./ask-ledger.mjs";
import { ledgerFiles, readScanCache, readWholeLinesFrom, writeScanCache } from "./ask-ledger-scan.mjs";

/** WHAT: Names the least history a pane needs to be suggested. WHY: Keeps a word nobody works on, such as freefall, from warning. */
export const HISTORY_MIN_ENTRIES = 20;
const SUGGESTED_PANES = 5;
const CACHE_VERSION = 1;

/** WHAT: Returns the folder whose git clones are the projects. WHY: Keeps this guard on the ~/lsrc default disk relief uses. */
export const projectsRoot = (env = process.env) => env.AMUX_PROJECTS_ROOT || join(homedir(), "lsrc");

const isClone = (path) => { try { return statSync(join(path, ".git")).isDirectory(); } catch { return false; } };

/**
 * WHAT: Maps each project name to its clone, adding a unique first part as short name.
 * WHY: Keeps worktree copies out of the list, and lets "Haunt" name haunt-lab.
 */
export function projectNames(root = projectsRoot()) {
  let clones = [];
  try { clones = readdirSync(root).filter((name) => isClone(join(root, name))); } catch { return new Map(); }
  const names = new Map(clones.map((clone) => [clone.toLowerCase(), clone]));
  const byFirstPart = Map.groupBy(clones.filter((clone) => clone.includes("-")), (clone) => clone.split("-")[0].toLowerCase());
  for (const [part, owners] of byFirstPart) if (owners.length === 1 && part.length >= 4 && !names.has(part)) names.set(part, owners[0]);
  return names;
}

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/**
 * WHAT: Returns a function giving the projects a text names, in order.
 * WHY: Keeps briefs and history on one reading: cutkit-wt names cutkit, skybar:2 names nothing.
 */
export function projectNamer(names) {
  if (!names.size) return () => new Set();
  const words = [...names.keys()].sort((left, right) => right.length - left.length).map(escape).join("|");
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_-])(${words})(?![\\p{L}\\p{N}_]|:\\d)`, "giu");
  return (text) => new Set([...String(text || "").matchAll(pattern)].map((match) => names.get(match[1].toLowerCase())));
}

// A pane's history is its own replies and what Mattias asked it; briefs other agents sent it would count themselves.
function countMentions(text, nameIn, counts) {
  const next = structuredClone(counts);
  for (const line of text.split("\n")) {
    const reply = line.includes("\"kind\":\"reply\"");
    if (!reply && !(line.includes("\"source\":\"discord\"") && line.includes("\"event\":\"ask\""))) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry.agent || !Number.isInteger(Number(entry.pane))) continue;
      const pane = `${entry.agent}:${entry.pane}`;
      for (const project of nameIn(entry.verbatim || entry.text)) {
        next[project] ??= {};
        next[project][pane] = (next[project][pane] || 0) + 1;
      }
    } catch { /* a torn last line is read again on the next send */ }
  }
  return next;
}

/**
 * WHAT: Collects each pane's history per project from every ask ledger, through an offset cache.
 * WHY: Keeps a send from parsing hundreds of megabytes; archives are read once, the live ledger incrementally.
 */
export function readProjectHistory({
  ledgerPath = defaultAskLedgerPath(),
  cachePath = join(dirname(ledgerPath), "history-guard", "project-history.json"),
  names = projectNames(),
} = {}) {
  // A new clone changes what counts as a mention, so the counts are made again.
  const signature = [...names.keys()].sort().join(" ");
  const stored = readScanCache(cachePath, CACHE_VERSION);
  const cache = stored.signature === signature ? stored : { version: CACHE_VERSION, signature, files: {} };
  const nameIn = projectNamer(names);
  const next = { version: CACHE_VERSION, signature, files: {} };
  let changed = cache !== stored;
  for (const file of ledgerFiles(ledgerPath)) {
    const prior = cache.files[file.path];
    const reusable = prior && prior.ino === file.ino && prior.offset <= file.size;
    const read = reusable && prior.offset === file.size ? null : readWholeLinesFrom(file, reusable ? prior.offset : 0);
    const counts = read ? countMentions(read.text, nameIn, reusable ? prior.counts : {}) : prior.counts;
    next.files[file.path] = { ino: file.ino, offset: read ? read.offset : prior.offset, counts };
    changed ||= !reusable || Boolean(read?.text);
  }
  if (changed || Object.keys(next.files).length !== Object.keys(cache.files).length) writeScanCache(cachePath, next);
  const total = {};
  for (const { counts } of Object.values(next.files)) {
    for (const [project, byPane] of Object.entries(counts)) {
      total[project] ??= {};
      for (const [pane, count] of Object.entries(byPane)) total[project][pane] = (total[project][pane] || 0) + count;
    }
  }
  return total;
}

/** WHAT: Formats one warning per named project the target has no history in. WHY: Keeps a pane without history from being staffed unseen. */
export function unfamiliarProjectWarnings(projects, target, history) {
  return [...projects].flatMap((project) => {
    const byPane = history[project] || {};
    if (byPane[target]) return [];
    const familiar = Object.entries(byPane).filter(([pane, count]) => pane !== target && count >= HISTORY_MIN_ENTRIES)
      .sort((left, right) => right[1] - left[1]).slice(0, SUGGESTED_PANES);
    if (!familiar.length) return [];
    return [`amux: warning: ${target} has no conversation history in ${project}. Panes that have it: `
      + `${familiar.map(([pane, count]) => `${pane} (${count})`).join(", ")}. The send goes ahead.`];
  });
}

/**
 * WHAT: Reports on stderr each project a brief names that its target never worked in.
 * WHY: Keeps the check from ever blocking or failing a send, unlike the quote guard.
 */
export function warnUnfamiliarProject(text, target, {
  enabled = process.env.AMUX_HISTORY_GUARD_ENABLED !== "false",
  print = console.error,
  names = null,
  ...ledger
} = {}) {
  if (!enabled) return [];
  try {
    const projectsOf = names || projectNames();
    const projects = projectNamer(projectsOf)(text);
    if (!projects.size) return [];
    const warnings = unfamiliarProjectWarnings(projects, target, readProjectHistory({ ...ledger, names: projectsOf }));
    for (const warning of warnings) print(warning);
    return warnings;
  } catch (error) {
    print(`amux: warning: the project history check failed (${error.message}); the send goes ahead.`);
    return [];
  }
}
