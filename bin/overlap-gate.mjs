#!/usr/bin/env node
// overlap-gate — deterministic file-zone gate for multi-worktree fleets.
//
// Replaces ad-hoc broker reasoning ("does SKY-0039 collide with SKY-0025?")
// with one command and an exit code.
//
// Usage:
//   overlap-gate scan <repo> [--json]
//       Full state: every worktree's file zone, pairwise overlaps,
//       merged-but-not-removed worktrees (prune candidates), stale bases.
//
//   overlap-gate check <repo> <path...> [--json]
//       Gate a PLANNED file zone before assigning a ticket.
//       Paths match exact files or directory prefixes.
//       Exit 0 = CLEAR (assign), 1 = OVERLAP (sequence or stack), 2 = error.
//
// Read-only: never deletes worktrees, never mutates repos. Prune candidates
// are reported with the exact removal command for the owner to run.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// --- git plumbing (throws on infra errors: bad repo, git missing) ---

const gitRaw = (repo, ...args) => execFileSync(
  "git",
  ["-C", repo, ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

const git = (repo, ...args) => gitRaw(repo, ...args).replace(/\r?\n$/, "");

const gitLines = (repo, ...args) => {
  const out = git(repo, ...args);
  return out === "" ? [] : out.split("\n");
};

// --- domain ---

const detectTrunk = (repo) => {
  for (const ref of ["origin/master", "origin/main", "master", "main"]) {
    try {
      git(repo, "rev-parse", "--verify", "--quiet", ref);
      return ref;
    } catch { /* next */ }
  }
  return null; // caller fails loud
};

const listWorktrees = (repo) => {
  const blocks = git(repo, "worktree", "list", "--porcelain").split("\n\n");
  return blocks.filter(Boolean).map((block) => {
    const lines = block.split("\n");
    const field = (key) => lines.find((line) => line.startsWith(`${key} `))
      ?.slice(key.length + 1) ?? null;
    return {
      path: field("worktree"),
      head: field("HEAD"),
      branch: field("branch")?.replace("refs/heads/", "") ?? "(detached)",
      broken: !existsSync(field("worktree") ?? ""),
    };
  });
};

// Build junk is never a coordination zone even when a worktree lacks
// .gitignore coverage for it. Deliberate, visible filter — not a fallback.
const ZONE_NOISE = /^(node_modules|dist|build|\.playwright-mcp)(\/|$)/;

const parseStatusPorcelainV1Z = (raw) => {
  const records = raw.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new Error("unexpected git status --porcelain=v1 -z record");
    }
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    // In -z mode a rename/copy's destination is in this record and its old
    // path is the following NUL-delimited field. The destination is the live
    // coordination zone; skip the old path.
    if (/[RC]/.test(status)) index += 1;
  }
  return paths;
};

const uncommittedFiles = (worktree) => parseStatusPorcelainV1Z(gitRaw(
  worktree,
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
)).filter((path) => !ZONE_NOISE.test(path));

const committedFilesVsTrunk = (repo, worktree, trunk) => {
  const base = git(repo, "merge-base", trunk, `${worktree.head}`);
  return { base, files: gitLines(repo, "diff", "--name-only", `${base}..${worktree.head}`) };
};

const isMergedIntoTrunk = (repo, head, trunk) => {
  try {
    git(repo, "merge-base", "--is-ancestor", head, trunk);
    return true;
  } catch {
    return false;
  }
};

const analyzeWorktree = (repo, trunk, trunkHead, worktree) => {
  if (worktree.broken) return { ...worktree, status: "broken", files: [] };
  const dirty = uncommittedFiles(worktree.path);
  const { base, files: committed } = committedFilesVsTrunk(repo, worktree, trunk);
  const files = [...new Set([...committed, ...dirty])].sort();
  const merged = isMergedIntoTrunk(repo, worktree.head, trunk);
  // The main dev checkout is coordination ground truth, not a competing zone,
  // regardless of whether it tracks master or main locally.
  const isTrunkCheckout = ["master", "main"].includes(worktree.branch);
  return {
    ...worktree,
    files,
    dirtyCount: dirty.length,
    status: isTrunkCheckout ? "trunk"
      : merged && files.length === 0 ? "merged-clean" // prune candidate
        : merged ? "merged-dirty" // prune candidate w/ leftovers
          : "active",
    staleBase: !merged && base !== trunkHead,
  };
};

// A planned path blocks if it equals a zone file or either is a dir-prefix
// of the other ("src/audio/" vs "src/audio/mixer.js").
const pathsCollide = (a, b) => {
  const norm = (path) => path.replace(/\/+$/, "");
  const [x, y] = [norm(a), norm(b)];
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

const zoneOverlap = (zoneA, zoneB) =>
  zoneA.filter((a) => zoneB.some((b) => pathsCollide(a, b)));

const pairwiseOverlaps = (actives) => {
  const overlaps = [];
  for (let i = 0; i < actives.length; i += 1) {
    for (let j = i + 1; j < actives.length; j += 1) {
      const files = zoneOverlap(actives[i].files, actives[j].files);
      if (files.length) overlaps.push({ a: actives[i].branch, b: actives[j].branch, files });
    }
  }
  return overlaps;
};

// --- commands ---

const scanRepo = (repo) => {
  const trunk = detectTrunk(repo);
  if (!trunk) throw new Error(`no master/main branch found in ${repo}`);
  const trunkHead = git(repo, "rev-parse", trunk);
  const worktrees = listWorktrees(repo).map((worktree) =>
    analyzeWorktree(repo, trunk, trunkHead, worktree));
  const actives = worktrees.filter((worktree) => worktree.status === "active");
  return {
    repo: resolve(repo),
    trunk,
    trunkHead,
    worktrees,
    overlaps: pairwiseOverlaps(actives),
    pruneCandidates: worktrees.filter((worktree) =>
      ["merged-clean", "merged-dirty", "broken"].includes(worktree.status)),
  };
};

const checkZone = (repo, plannedPaths) => {
  const scan = scanRepo(repo);
  const actives = scan.worktrees.filter((worktree) => worktree.status === "active");
  const conflicts = actives
    .map((worktree) => ({
      branch: worktree.branch,
      path: worktree.path,
      files: zoneOverlap(plannedPaths, worktree.files),
    }))
    .filter((conflict) => conflict.files.length);
  return { ...scan, plannedPaths, conflicts, clear: conflicts.length === 0 };
};

// --- rendering ---

const renderScan = (scan) => {
  const lines = [
    `overlap-gate scan: ${scan.repo}  (trunk ${scan.trunk} @ ${scan.trunkHead.slice(0, 7)})`,
    "",
  ];
  const actives = scan.worktrees.filter((worktree) => worktree.status === "active");
  lines.push(`ACTIVE ZONES (${actives.length}):`);
  for (const worktree of actives) {
    const flags = [
      worktree.staleBase ? "STALE-BASE" : null,
      worktree.dirtyCount ? `${worktree.dirtyCount} dirty` : null,
    ].filter(Boolean).join(", ");
    lines.push(`  ${worktree.branch}${flags ? `  [${flags}]` : ""}`);
    for (const file of worktree.files.slice(0, 8)) lines.push(`    ${file}`);
    if (worktree.files.length > 8) lines.push(`    … +${worktree.files.length - 8} more`);
  }
  lines.push(
    "",
    scan.overlaps.length
      ? `OVERLAPS (${scan.overlaps.length}) — these pairs must sequence or stack:`
      : "OVERLAPS: none — all active zones disjoint.",
  );
  for (const overlap of scan.overlaps) {
    lines.push(`  ✗ ${overlap.a} ⟂ ${overlap.b}: ${overlap.files.join(", ")}`);
  }
  if (scan.pruneCandidates.length) {
    lines.push(
      "",
      `PRUNE CANDIDATES (${scan.pruneCandidates.length}) — merged/broken worktrees still on disk (these wedge gates):`,
    );
    for (const worktree of scan.pruneCandidates) {
      const dirtyNote = worktree.status === "merged-dirty"
        ? "  # has leftovers, inspect first"
        : "";
      lines.push(
        `  ${worktree.status === "broken" ? "✗ broken" : worktree.status}: ${worktree.branch}`,
        `    → git -C ${scan.repo} worktree remove ${worktree.path}${dirtyNote}`,
      );
    }
  }
  return lines.join("\n");
};

const renderCheck = (result) => {
  const lines = [`overlap-gate check: ${result.plannedPaths.join(", ")}`];
  if (result.clear) {
    lines.push("✓ CLEAR — no active worktree touches this zone. Safe to assign.");
  } else {
    lines.push(`✗ OVERLAP — blocked by ${result.conflicts.length} active worktree(s):`);
    for (const conflict of result.conflicts) {
      lines.push(
        `  ${conflict.branch}: ${conflict.files.join(", ")}`,
        `    at ${conflict.path}`,
      );
    }
    lines.push("  → sequence behind them, or stack the tickets under that owner.");
  }
  if (result.pruneCandidates.length) {
    lines.push(
      `ℹ ${result.pruneCandidates.length} merged/broken worktree(s) need removal (see: overlap-gate scan).`,
    );
  }
  return lines.join("\n");
};

// --- cli ---

const main = () => {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  const [command, repo, ...rest] = args;

  if (!command || !repo || !["scan", "check"].includes(command)) {
    console.error("usage: overlap-gate scan <repo> [--json]\n       overlap-gate check <repo> <path...> [--json]");
    process.exit(2);
  }
  if (command === "check" && rest.length === 0) {
    console.error("check needs at least one planned path (file or directory)");
    process.exit(2);
  }

  // process.exitCode (not process.exit) — exit() truncates stdout >64KB mid-flush
  if (command === "scan") {
    const scan = scanRepo(repo);
    console.log(json ? JSON.stringify(scan, null, 2) : renderScan(scan));
    process.exitCode = 0;
    return;
  }
  const result = checkZone(repo, rest);
  console.log(json ? JSON.stringify(result, null, 2) : renderCheck(result));
  process.exitCode = result.clear ? 0 : 1;
};

try {
  main();
} catch (error) {
  console.error(`overlap-gate: ${error.message}`);
  process.exitCode = 2;
}
