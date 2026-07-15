#!/usr/bin/env node
// Stdlib-only bootstrap entry point: it must run before this worktree has deps.

import {
  formatWorktreeDeps,
  provisionWorktreeDependencies,
} from "../core/worktree-deps.mjs";

const args = process.argv.slice(2);
const check = args.includes("--check");
const dryRun = args.includes("--dry");
const positional = args.filter((arg) => arg !== "--check" && arg !== "--dry");
if (positional.length > 1 || (check && dryRun) || args.some((arg) => arg.startsWith("-") && arg !== "--check" && arg !== "--dry")) {
  console.error("Usage: node bin/worktree-deps.mjs [path] [--check|--dry]");
  process.exit(1);
}

const result = provisionWorktreeDependencies({
  root: positional[0] || process.cwd(),
  check,
  dryRun,
});
console.log(formatWorktreeDeps(result));
if (!result.ok && !result.planned) process.exitCode = 1;
