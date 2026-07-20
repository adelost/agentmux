#!/usr/bin/env node
// Focused PR tests: maps files changed vs the base ref to their related fast
// test files and runs exactly those. The PR gate never invokes the full
// Vitest suite; a full repository run requires explicit owner authorization.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

/** WHAT: Maps one changed file to its related fast test files. WHY: Keeps the PR gate focused instead of full-suite. */
export function relatedTests(file, { exists = existsSync } = {}) {
  const aliases = {
    "cli/commands.mjs": ["cli.test/commands.test.mjs"],
  };
  if (aliases[file]) return aliases[file].filter(exists);
  if (/\.test\.mjs$/u.test(file)) return exists(file) ? [file] : [];
  const candidate = file.replace(/\.mjs$/u, ".test.mjs");
  return exists(candidate) ? [candidate] : [];
}

/** WHAT: Resolves the focused test set for the changed files. WHY: Prevents unmapped changes from silently widening the gate. */
export function focusedTestSet({ base = "origin/master", exec = execFileSync, exists = existsSync } = {}) {
  const diff = exec("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  const changed = diff.split("\n").map((line) => line.trim()).filter(Boolean);
  return [...new Set(changed.flatMap((file) => relatedTests(file, { exists })))].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.AMUX_TEST_BASE_REF || "origin/master";
  const tests = focusedTestSet({ base });
  if (!tests.length) {
    console.log("focused-tests: no related test files for this change; strict lint + CI contract cover it");
    process.exit(0);
  }
  console.log(`focused-tests: running ${tests.length} related file(s): ${tests.join(", ")}`);
  execFileSync("npx", ["vitest", "run", ...tests], { stdio: "inherit" });
}
