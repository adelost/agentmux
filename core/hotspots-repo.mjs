/**
 * WHAT: Reads hotspot facts from a git checkout: trunk churn per function (git blame), function spans (lizard)
 * and the verdict ledger under ~/.agentmux/hotspots.
 * WHY: Keeps git, process and file IO out of the rules in core/hotspots.mjs so they stay unit-testable.
 */
import { execFile, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_HOTSPOT_POLICY, functionChurn, isFunctionSource, parseChangedRanges, parseLizardCsv,
  reflectionDue, touchedFunctions,
} from "./hotspots.mjs";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 64 * 1024 * 1024;

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (result.status !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || "").trim()}`);
  }
  return result.stdout;
}

/** The trunk this checkout merges into: origin/HEAD, else origin/main|master, else local main|master. */
function trunkRef(cwd) {
  const originHead = git(cwd, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { allowFailure: true })?.trim();
  if (originHead) return originHead;
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (git(cwd, ["rev-parse", "-q", "--verify", `${ref}^{commit}`], { allowFailure: true })) return ref;
  }
  return null;
}

/** A stable ledger key shared by every worktree of one repository. */
function repoKey(cwd) {
  const origin = git(cwd, ["config", "--get", "remote.origin.url"], { allowFailure: true })?.trim();
  if (origin) return origin.replace(/^[a-z]+:\/\//iu, "").replace(/^git@/u, "").replace(/:/gu, "/").replace(/\.git$/u, "");
  return dirname(resolve(cwd, git(cwd, ["rev-parse", "--git-common-dir"]).trim()));
}

function configuredPolicy(cwd) {
  const read = (name, fallback) => {
    const value = git(cwd, ["config", "--get", `amux.hotspots.${name}`], { allowFailure: true })?.trim();
    if (!value) return fallback;
    if (!/^\d+$/u.test(value) || Number(value) < 1) throw new Error(`git config amux.hotspots.${name} must be a positive integer, got ${value}`);
    return Number(value);
  };
  return {
    minChurn: read("minChurn", DEFAULT_HOTSPOT_POLICY.minChurn),
    windowDays: read("windowDays", DEFAULT_HOTSPOT_POLICY.windowDays),
    reopenAfter: read("reopenAfter", DEFAULT_HOTSPOT_POLICY.reopenAfter),
  };
}

/** Repository facts every hotspot command needs, or null outside a git checkout or without a trunk. */
export function hotspotRepo(cwd) {
  const root = git(cwd, ["rev-parse", "--show-toplevel"], { allowFailure: true })?.trim();
  if (!root) return null;
  const trunk = trunkRef(root);
  if (!trunk || !git(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], { allowFailure: true })) return null;
  return { root, trunk, key: repoKey(root), headSha: git(root, ["rev-parse", "HEAD"]).trim(), policy: configuredPolicy(root) };
}

export function ledgerPath(repo) {
  const dir = process.env.AMUX_HOTSPOTS_DIR || join(homedir(), ".agentmux", "hotspots");
  return join(dir, `${repo.key.replace(/[^A-Za-z0-9._-]+/gu, "__")}.jsonl`);
}

export function readLedger(repo) {
  const path = ledgerPath(repo);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function appendLedger(repo, entry) {
  const path = ledgerPath(repo);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** Function spans at HEAD for the given repo-relative paths. Lizard runs on HEAD blobs, never on uncommitted edits. */
export function headFunctions(repo, paths) {
  const sources = paths.filter(isFunctionSource);
  if (!sources.length) return [];
  const scratch = mkdtempSync(join(tmpdir(), "amux-hotspots-"));
  try {
    const present = [];
    for (const path of sources) {
      const blob = git(repo.root, ["show", `HEAD:${path}`], { allowFailure: true });
      if (blob === null) continue;
      mkdirSync(dirname(join(scratch, path)), { recursive: true });
      writeFileSync(join(scratch, path), blob);
      present.push(path);
    }
    if (!present.length) return [];
    const [command, ...prefix] = (process.env.AMUX_LIZARD || "uvx lizard").split(/\s+/u);
    const result = spawnSync(command, [...prefix, "--csv", ...present], { cwd: scratch, encoding: "utf8", maxBuffer: MAX_BUFFER });
    if (result.status !== 0) {
      throw new Error(`lizard could not split functions (${command} ${prefix.join(" ")}): ${(result.stderr || result.error?.message || "").trim().slice(0, 300)}`);
    }
    return parseLizardCsv(result.stdout);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function trunkShas(repo) {
  return new Set(git(repo.root, ["rev-list", `--since=${repo.policy.windowDays}.days`, repo.trunk]).split("\n").filter(Boolean));
}

/** Blame ranges (inside the window) and commit subjects for one file at HEAD. */
async function blameFile(repo, path) {
  const { stdout } = await execFileAsync("git", ["-C", repo.root, "blame", "--incremental", "--root", "-w",
    `--since=${repo.policy.windowDays}.days`, "HEAD", "--", path], { maxBuffer: MAX_BUFFER });
  const ranges = [];
  const commits = new Map();
  const boundary = new Set();
  let current = null;
  for (const line of stdout.split("\n")) {
    const head = /^([0-9a-f]{40}) \d+ (\d+) (\d+)$/u.exec(line);
    if (head) {
      current = head[1];
      ranges.push({ start: Number(head[2]), count: Number(head[3]), sha: current });
      if (!commits.has(current)) commits.set(current, { subject: "" });
    } else if (line === "boundary") boundary.add(current);
    else if (line.startsWith("summary ")) commits.get(current).subject = line.slice(8);
  }
  return { ranges: ranges.filter((range) => !boundary.has(range.sha)), commits };
}

async function inPool(items, size, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

/** Churn facts for `functions`, blaming each file once; `fileFunctions` are every function in those files. */
export async function withChurn(repo, functions, fileFunctions = functions) {
  const shas = trunkShas(repo);
  const paths = [...new Set(functions.map((fn) => fn.path))];
  const blames = new Map((await inPool(paths, 8, async (path) => [path, await blameFile(repo, path)])));
  return functions.map((fn) => {
    const { ranges, commits } = blames.get(fn.path);
    const siblings = fileFunctions.filter((other) => other.path === fn.path);
    return { ...fn, ...functionChurn(fn, siblings, ranges, shas, commits) };
  });
}

/** Hot functions changed in the working tree (staged or not) that still need a verdict. */
export async function changedHotspotsDue(repo) {
  const diff = git(repo.root, ["diff", "HEAD", "-U0", "--no-color", "--no-ext-diff", "--no-renames"]);
  const changed = parseChangedRanges(diff);
  const all = headFunctions(repo, [...changed.keys()]);
  const functions = touchedFunctions(all, changed);
  if (!functions.length) return [];
  const ledger = readLedger(repo);
  return (await withChurn(repo, functions, all))
    .map((hotspot) => ({ hotspot, ...reflectionDue(hotspot, ledger, repo.policy) }))
    .filter((item) => item.reason);
}

/** Every function hot on trunk right now, hottest first, with its latest verdict. */
export async function repoHotspots(repo) {
  const log = git(repo.root, ["log", `--since=${repo.policy.windowDays}.days`, "--name-only", "--format=", repo.trunk]);
  const paths = [...new Set(log.split("\n").filter(isFunctionSource))];
  const functions = [];
  for (let index = 0; index < paths.length; index += 200) functions.push(...headFunctions(repo, paths.slice(index, index + 200)));
  return (await withChurn(repo, functions))
    .filter((fn) => fn.churn >= repo.policy.minChurn)
    .sort((a, b) => b.churn - a.churn || b.fixes - a.fixes);
}
