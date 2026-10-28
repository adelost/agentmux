// Nightly and high-use root-disk cleanup. Every category plans first and
// re-checks each item just before acting, so a dry run lists exactly what a
// real run would remove. Old artifact folders keep their receipts; the rest is deleted, never moved to Q:,
// which sits on the same SSD.
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { RETENTION_DAYS, planArtifactRetention, pruneArtifacts } from "./artifact-retention.mjs";
import { applyDependencyCacheRetention, dependencySymlinkConsumers, sampleRootDisk } from "./disk-cache-retention.mjs";
import { dependencyCacheRepositories, packageCacheCandidates, readProcessArgs, removeIdleCache, uvPruneAllowed } from "./disk-pressure-relief.mjs";
import { processPathReferences } from "./process-path-references.mjs";
import { measureTrees } from "./tree-usage.mjs";
import { checkoutReasons, IGNORED_FILES_REASON, PROTECTED_DATA_REASON, registeredWorktrees, retireCheckouts, retirableWorktrees,
  retirementReceiptRoots, retirementSafety } from "./worktree-retirement.mjs";

const WORKTREE_CONTAINER = /(?:-wt|^\.worktrees|^\.agents)$/u;

/** WHAT: Reads the shared Git directory a linked checkout points to. WHY: Finds repositories whose worktrees live in container folders without a Git call per folder. */
function commonFromGitFile(dir) {
  try {
    const match = /^gitdir: (.+\/worktrees\/[^/\n]+)\s*$/u.exec(readFileSync(join(dir, ".git"), "utf8"));
    return match ? dirname(dirname(match[1])) : null;
  } catch { return null; }
}

/** WHAT: Collects every repository that may own linked worktrees. WHY: Keeps container folders (cutkit-wt, .worktrees, .agents/N) from hiding their repositories. */
export function worktreeRepositories({ lsrc = join(homedir(), "lsrc") } = {}) {
  const commons = new Set();
  const directories = (path) => { try { return readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map(({ name }) => join(path, name)); } catch { return []; } };
  for (const dir of directories(lsrc)) {
    try { if (lstatSync(join(dir, ".git")).isDirectory()) commons.add(join(dir, ".git")); } catch { /* not a repository */ }
    if (!WORKTREE_CONTAINER.test(dir.split("/").at(-1))) continue;
    for (const child of directories(dir)) {
      const common = commonFromGitFile(child);
      if (common) { commons.add(common); continue; }
      for (const grandchild of directories(child)) { const nested = commonFromGitFile(grandchild); if (nested) commons.add(nested); }
    }
  }
  return [...commons].sort();
}

/** WHAT: Refreshes origin refs with prune. WHY: Keeps "pushed or merged" on what origin holds now, not on refs from an older fetch. */
const fetchOrigin = (common) => {
  try { execFileSync("git", [`--git-dir=${common}`, "fetch", "--prune", "--quiet", "origin"], { stdio: "ignore", timeout: 120000 }); return true; }
  catch { return false; }
};

// Git facts narrow thousands of checkouts first; the process and receipt scan then covers every checkout it may clear.
/** WHAT: Collects finished worktrees admitted by every retirement guard. WHY: Keeps unscanned checkouts from being cleared. */
export function planWorktreeCleanup({ commons = worktreeRepositories(), nowMs = Date.now(), fetch = fetchOrigin,
  receiptRoots = retirementReceiptRoots(homedir()), safetyFor = retirementSafety } = {}) {
  const repositories = [], skipped = [], linkedPaths = [];
  for (const common of commons) {
    let linked;
    try { linked = registeredWorktrees(common); } catch (error) { skipped.push({ target: common, reasons: [`unreadable worktree list: ${error.message.split("\n")[0]}`] }); continue; }
    if (!linked.length) continue;
    linkedPaths.push(...linked.map(({ path }) => path));
    if (!fetch(common)) { for (const { path } of linked) skipped.push({ target: path, reasons: ["origin fetch failed"] }); continue; }
    const narrowed = linked.filter((candidate) => {
      const reasons = checkoutReasons({ common, candidate });
      if (reasons.length) skipped.push({ target: candidate.path, reasons });
      return !reasons.length;
    });
    repositories.push({ common, narrowed });
  }
  const targets = repositories.flatMap(({ narrowed }) => narrowed.map(({ path }) => path));
  const safety = targets.length ? safetyFor(repositories[0].common, [...receiptRoots, ...repositories.map(({ common }) => dirname(common))], nowMs, targets)
    : { holders: {}, protectedPaths: [], errors: [] };
  for (const repository of repositories) {
    repository.retirements = retirableWorktrees({ common: repository.common, now: nowMs, safety, candidates: repository.narrowed,
      onSkipped: (entry) => skipped.push(entry) });
  }
  return { repositories, skipped, linkedPaths, safety, errors: safety.errors };
}

// uv's own prune decides which entries are unused. It runs only when no process has anything in the
// cache in its maps, cwd or descriptors and nothing installs: a forced prune on 2026-10-22 removed an
// archive that 16 running voice-mode processes still mapped.
/** WHAT: Checks the uv cache for holders and running installs. WHY: Prevents a prune from removing files a process still maps or an install writes. */
export function uvPruneVerdict({ ps, cacheDir = join(homedir(), ".cache/uv"), references = processPathReferences, exists = existsSync(cacheDir) } = {}) {
  if (!exists) return { mode: "kept", reason: "no uv cache" };
  if (!uvPruneAllowed(ps)) return { mode: "kept", reason: "uv sync, add or pip install is running" };
  const safety = references([cacheDir]);
  if (safety.errors.length || !Array.isArray(safety.holders?.[cacheDir])) return { mode: "kept", reason: "unreadable process evidence" };
  if (safety.holders[cacheDir].length) return { mode: "kept", reason: `${safety.holders[cacheDir].length} processes map or hold files in the cache` };
  return { mode: "would prune" };
}

/** WHAT: Dispatches uv's plain prune after a fresh holder check. WHY: Keeps df evidence for the uv cache without overriding its lock. */
function pruneUv({ ps, run = (args) => execFileSync(join(homedir(), ".local/bin/uv"), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 600000 }) }) {
  const verdict = uvPruneVerdict({ ps });
  if (verdict.mode !== "would prune") return verdict;
  const before = sampleRootDisk(), entry = { at: new Date().toISOString(), before, mode: "attempting" };
  try { entry.summary = run(["cache", "prune"]).trim().split("\n").at(-1); entry.mode = "pruned"; }
  catch (error) { entry.mode = "refused"; entry.error = (error.stderr?.toString().trim() || error.message).split("\n")[0]; }
  entry.after = sampleRootDisk(); entry.freedBytes = entry.after.availableBytes - before.availableBytes;
  return entry;
}

/** WHAT: Reads one Docker listing as JSON lines. WHY: Keeps a missing or stopped Docker daemon visible instead of an empty plan. */
const dockerLines = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 })
  .split("\n").filter(Boolean);

/** WHAT: Collects images no running container uses, with the stopped containers that still name them. WHY: Keeps image removal a reviewed decision; volumes and their databases are never listed. */
export function planDockerImages({ lines = dockerLines } = {}) {
  try {
    // With the containerd store, inspect's Size is the compressed content; the listing shows unpacked decimal sizes.
    const unit = { B: 1, kB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
    const images = lines(["image", "ls", "--no-trunc", "--format", "{{.ID}}\t{{.Repository}}:{{.Tag}}\t{{.Size}}"]).map((line) => line.split("\t"));
    const sizes = Object.fromEntries(images.map(([id, , size]) => {
      const [, value, suffix] = /^([\d.]+)\s*([kMGT]?B)$/u.exec(size) ?? [];
      if (!value) throw new Error(`unreadable image size ${size}`);
      return [id, Number(value) * unit[suffix]];
    }));
    // A container names its image by tag or by an ID prefix; dead containers cannot be inspected one by one.
    const imageOf = (reference) => images.find(([id, name]) => name === reference || name === `${reference}:latest`
      || id.replace(/^sha256:/u, "").startsWith(reference))?.[0];
    const uses = lines(["ps", "-a", "--no-trunc", "--format", "{{.Image}}\t{{.State}}"]).map((line) => line.split("\t"))
      .map(([reference, state]) => [imageOf(reference), state]);
    const running = new Set(uses.filter(([, state]) => state === "running").map(([id]) => id));
    const stopped = new Set(uses.filter(([, state]) => state !== "running").map(([id]) => id));
    const unused = images.filter(([id]) => !running.has(id)).map(([id, name]) => ({ id, name, bytes: sizes[id] ?? 0, stoppedContainers: stopped.has(id) }));
    return { unused, runningImages: running.size, errors: [] };
  } catch (error) { return { unused: [], runningImages: 0, errors: [{ error: `docker unreadable: ${error.message.split("\n")[0]}` }] }; }
}

// Order: dependency entries, worktrees, package caches, uv, then artifact pruning. Unlinking a cache
// entry first lets the worktree removal drop the last link of its files.
/** WHAT: Dispatches every cleanup category, or only plans it in a dry run. WHY: Keeps the dry run and the real run on one plan; Docker images are only listed. */
export function runDiskCleanup({ dryRun = true, measure = dryRun, nowMs = Date.now(), home = homedir(),
  journal = join(home, ".agentmux", "janitor", "retirements.jsonl") } = {}) {
  const started = sampleRootDisk(), steps = [];
  // df around each acting row; other writers on / move it too, so it is evidence per row, not exact.
  const step = (name, act) => { const before = sampleRootDisk(), value = act(); steps.push({ name, before, after: sampleRootDisk() }); return value; };
  const worktrees = planWorktreeCleanup({ nowMs });
  // Registered worktrees whose folder is gone stay out: find fails on a missing root, and that would hold every entry.
  const searchRoots = [join(home, "lsrc"), ...worktrees.linkedPaths.filter((path) => !path.startsWith(`${join(home, "lsrc")}/`) && existsSync(path))];
  const repositoryRoots = dependencyCacheRepositories();
  const storeRoots = [join(home, ".cache/agentmux/agentmux-worktree-deps"),
    ...repositoryRoots.concat(worktrees.repositories.map(({ common }) => dirname(common)))
      .map((root) => join(root, ".git", "agentmux-worktree-deps")).filter(existsSync)];
  const dependencies = step("dependencies", () => applyDependencyCacheRetention({ dryRun, nowMs, repositoryRoots, storeRoots: [...new Set(storeRoots)],
    consumers: (entries) => dependencySymlinkConsumers(entries, { searchRoots }) }));
  const retired = step("worktrees", () => (dryRun ? [] : worktrees.repositories.flatMap(({ common, retirements }) => retireCheckouts({ common, journal, now: nowMs,
    safety: worktrees.safety, cell: "amux.disk-cleanup/worktree.retire", retirements }))));
  const ps = readProcessArgs();
  const caches = packageCacheCandidates({ home, ps });
  const cacheActions = step("caches", () => (dryRun ? [] : caches.map(removeIdleCache)));
  const uv = step("uv", () => (dryRun ? uvPruneVerdict({ ps }) : pruneUv({ ps })));
  const docker = planDockerImages();
  const artifacts = planArtifactRetention({ nowMs });
  const pruned = step("artifacts", () => (dryRun ? [] : pruneArtifacts(artifacts, { nowMs, sampleDisk: sampleRootDisk })));
  const sizes = measure ? measureTrees([...worktrees.repositories.flatMap(({ retirements }) => retirements.map(({ target }) => target)), ...caches]) : {};
  return { dryRun, at: new Date(nowMs).toISOString(), started, finished: sampleRootDisk(), steps,
    worktrees: { ...worktrees, retired, sizes }, dependencies, caches: { candidates: caches, actions: cacheActions, sizes }, uv, docker,
    artifacts: { ...artifacts, pruned } };
}

const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
const sum = (items, field) => items.reduce((total, item) => total + (item?.[field] ?? 0), 0);

/** WHAT: Counts the most common hold reasons. WHY: Shows why space stays without listing thousands of paths. */
function heldSummary(skipped) {
  const counts = new Map();
  for (const { reasons } of skipped) for (const reason of reasons) {
    const key = reason.replace(/^\[Errno \d+\].*/u, "unreadable entry").replace(/:.*$/u, "");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([reason, count]) => `${count} ${reason}`).join(", ");
}

/** WHAT: Groups paths by the folder kind people recognize. WHY: Lets the report say how much of the worktree space is Cutkit's. */
const containerOf = (path) => /\/lsrc\/(cutkit-wt|\.worktrees|\.agents)\//u.exec(path)?.[1] ?? "other";
const storeOf = (path) => (path.includes("/.cache/agentmux/") ? "~/.cache/agentmux" : path.includes("/.git/agentmux-worktree-deps/") ? "in .git" : "in repos");

/** WHAT: Formats one line per category: count, size, df estimate, action and holds. WHY: Keeps approval with a person before anything runs. */
export function formatCleanupRows(result) {
  const rows = [];
  const retiring = result.worktrees.repositories.flatMap(({ retirements }) => retirements.map(({ target }) => target));
  const sized = (paths, sizes) => ({ bytes: sum(paths.map((path) => sizes[path]), "bytes"), freeable: sum(paths.map((path) => sizes[path]), "freeableBytes") });
  const byContainer = Object.entries(Object.groupBy(retiring, containerOf)).map(([name, paths]) => `${name} ${paths.length}`).join(", ");
  const trees = sized(retiring, result.worktrees.sizes);
  rows.push(`Worktrees, remove with git worktree remove: ${retiring.length} (${byContainer || "none"}), ${gb(trees.bytes)}, of which ${gb(trees.freeable)} unlinked elsewhere. Kept ${result.worktrees.skipped.length}: ${heldSummary(result.worktrees.skipped)}.`);
  const ignoredHeld = result.worktrees.skipped.flatMap(({ target, reasons }) => reasons.filter((reason) => reason.startsWith(IGNORED_FILES_REASON))
    .map((reason) => `${target.replace(homedir(), "~")} (${reason.split(": ")[1]})`));
  rows.push(`Worktrees kept for over 100 MB of ${IGNORED_FILES_REASON}: ${ignoredHeld.length}${ignoredHeld.length ? `: ${ignoredHeld.join(", ")}` : ""}.`);
  const protectedHeld = result.worktrees.skipped.flatMap(({ target, reasons }) => reasons.filter((reason) => reason.startsWith(PROTECTED_DATA_REASON))
    .map((reason) => `${target.replace(homedir(), "~")} (${reason.split(": ")[1]})`));
  rows.push(`Worktrees kept for ${PROTECTED_DATA_REASON} (wrangler state, database, credentials, browser profile): ${protectedHeld.length}${protectedHeld.length ? `: ${protectedHeld.join(", ")}` : ""}.`);
  for (const [store, entries] of Object.entries(Object.groupBy(result.dependencies.candidates, ({ path }) => storeOf(path)))) {
    rows.push(`Dependency entries unused 7 days (${store}), remove: ${entries.length}, ${gb(sum(entries, "bytes"))}, of which ${gb(sum(entries, "freeableBytes"))} frees now; the rest frees when the worktrees linking it go.`);
  }
  rows.push(`Dependency entries kept: ${result.dependencies.skipped.length}: ${heldSummary(result.dependencies.skipped)}${result.dependencies.errors.length ? `; held by errors: ${result.dependencies.errors.map(({ error }) => error).join("; ")}` : ""}.`);
  const caches = sized(result.caches.candidates, result.caches.sizes);
  rows.push(`npm, pip and old Playwright, remove: ${result.caches.candidates.length} (${result.caches.candidates.map((path) => path.replace(homedir(), "~")).join(", ") || "none"}), ${gb(caches.bytes)}.`);
  rows.push(`uv cache prune (no --force): ${result.uv.mode}${result.uv.reason ? `, ${result.uv.reason}` : ""}. uv decides which entries are unused, so the gain shows only in df afterwards.`);
  const docker = result.docker, stoppedOnly = docker.unused.filter(({ stoppedContainers }) => stoppedContainers);
  rows.push(`Docker images no running container uses, for approval only, never automatic: ${docker.unused.length}, ${gb(sum(docker.unused, "bytes"))} listed (shared layers count once per image). ${stoppedOnly.length} still belong to stopped containers (${[...new Set(stoppedOnly.map(({ name }) => name.split("/").at(-1).split(":")[0]))].join(", ")}), which go first; volumes stay${docker.errors.length ? `; ${docker.errors[0].error}` : ""}.`);
  const artifacts = result.artifacts;
  const onRoot = artifacts.candidates.filter(({ path }) => !path.startsWith("/mnt/"));
  rows.push(`Artifact folders unchanged ${RETENTION_DAYS} days, prune to receipts: ${artifacts.candidates.length}, ${gb(artifacts.pruneBytes)} to delete, ${gb(sum(onRoot, "pruneBytes"))} of it on / and the rest in the old Q: overflow. Kept whole ${artifacts.skipped.length}: ${heldSummary(artifacts.skipped)}${artifacts.errors.length ? `; held by errors: ${artifacts.errors.map(({ error }) => error).join("; ")}` : ""}.`);
  if (!result.dryRun) {
    const modes = (items) => Object.entries(Object.groupBy(items, ({ mode }) => mode)).map(([mode, list]) => `${list.length} ${mode}`).join(", ") || "none";
    rows.push(`Done: worktrees ${modes(result.worktrees.retired)}; dependency entries ${modes(result.dependencies.actions)}; caches ${modes(result.caches.actions)}; uv ${result.uv.mode}; artifacts ${modes(result.artifacts.pruned)}.`);
    rows.push(`df / free per row: ${result.steps.map(({ name, before, after }) => `${name} ${gb(before.availableBytes)} to ${gb(after.availableBytes)}`).join(", ")}.`);
  }
  if (result.worktrees.errors.length) rows.push(`Worktree safety errors hold every removal: ${result.worktrees.errors.map((error) => JSON.stringify(error)).join("; ")}`);
  rows.push(`df /: ${gb(result.started.availableBytes)} free before, ${gb(result.finished.availableBytes)} after${result.dryRun ? " (dry run, nothing changed)" : ""}.`);
  return rows;
}
