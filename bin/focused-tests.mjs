#!/usr/bin/env node
// Focused PR tests: maps files changed vs the base ref to their related fast
// test files and runs exactly those. The PR gate never invokes the full
// Vitest suite; a full repository run requires explicit owner authorization.
//
// Fail-closed: every changed executable source/config/script must map to a
// focused test, or the gate fails with the exact unmapped paths. Only the
// explicit narrow allowlist below may carry zero tests.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

// Only these may change without any focused test. Everything else maps or fails.
const ZERO_TEST_ALLOWLIST = [
  /\.md$/u, // documentation
  /^docs\/(?!check-ci-contract\.mjs$)/u, // docs tree (the CI contract itself is a check, not docs)
  /^docs\/check-ci-contract\.mjs$/u, // executed directly by the adjacent workflow step
  /\.(?:png|jpe?g|gif|webp|ico|mp4)$/u, // assets
  /^\.gitignore$/u,
  /^LICENSE$/u,
  /^\.amux-lint\.yml$/u, // lint policy: covered by the strict lint step itself
  /^\.github\/workflows\/[^/]+\.ya?ml$/u, // covered by docs/check-ci-contract.mjs
];

const TEST_ALIASES = {
  "bin/agent-cli.mjs": ["cli/restart-ready.test.mjs"],
  "cli/commands.mjs": ["cli.test/commands.test.mjs"],
  "bin/start.sh": ["test/post-boot-revive.integration.test.mjs"],
  "bin/post-boot-revive.sh": ["test/post-boot-revive.integration.test.mjs"],
  "bin/windows-bridge.mjs": ["core/windows-bridge.test.mjs", "test/windows-restarter-contract.test.mjs"],
  "bin/windows-discord-restarter.ps1": ["test/windows-restarter-contract.test.mjs"],
  "bin/windows-restarter-io.ps1": ["test/windows-restarter-contract.test.mjs"],
  "bin/windows-restarter-discord.ps1": ["test/windows-restarter-contract.test.mjs"],
  "bin/windows-wsl-probe.mjs": ["core/windows-wsl-probe.test.mjs"],
  "bin/windows-manager.mjs": ["bin/windows-manager-smoke.test.mjs", "test/windows-manager-contract.test.mjs"],
  "bin/windows-transcribe.py": ["core/windows-manager-input.test.mjs"],
  "bin/windows-manager-install.ps1": ["test/windows-manager-install-contract.test.mjs"],
  "bin/windows-rescue-tool.ps1": ["test/windows-manager-contract.test.mjs"],
  "core/windows-manager-discord.mjs": ["bin/windows-manager-smoke.test.mjs", "test/windows-manager-contract.test.mjs"],
  "package.json": ["core/release-install.test.mjs"],
  "package-lock.json": ["core/release-install.test.mjs"],
};

/** WHAT: Maps one changed file to its related fast test files. WHY: Keeps the PR gate focused instead of full-suite. */
export function relatedTests(file, { exists = existsSync } = {}) {
  if (TEST_ALIASES[file]) return TEST_ALIASES[file].filter(exists);
  if (/\.test\.mjs$/u.test(file)) return exists(file) ? [file] : [];
  if (!/\.mjs$/u.test(file)) return [];
  const candidate = file.replace(/\.mjs$/u, ".test.mjs");
  return exists(candidate) ? [candidate] : [];
}

/** WHAT: Filters changed files that carry no focused test outside the allowlist. WHY: Prevents untested executables from slipping the gate. */
export function unmappedExecutables(changed, { exists = existsSync } = {}) {
  return changed.filter((file) => {
    if (ZERO_TEST_ALLOWLIST.some((pattern) => pattern.test(file))) return false;
    return relatedTests(file, { exists }).length === 0;
  });
}

/** WHAT: Resolves the focused test set for the changed files. WHY: Keeps the gate explicit about what it covers. */
export function focusedTestSet({ base = "origin/master", exec = execFileSync, exists = existsSync } = {}) {
  const diff = exec("git", ["diff", "--name-only", `${base}...HEAD`], { encoding: "utf8" });
  const changed = diff.split("\n").map((line) => line.trim()).filter(Boolean);
  return {
    tests: [...new Set(changed.flatMap((file) => relatedTests(file, { exists })))].sort(),
    unmapped: unmappedExecutables(changed, { exists }),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.env.AMUX_TEST_BASE_REF || "origin/master";
  const { tests, unmapped } = focusedTestSet({ base });
  if (unmapped.length) {
    console.error(`focused-tests: FAIL: changed executables without a related focused test:\n  ${unmapped.join("\n  ")}`);
    console.error("Add a focused test, map an alias in bin/focused-tests.mjs, or document the change as allowlisted metadata.");
    process.exit(1);
  }
  if (!tests.length) {
    console.log("focused-tests: no related test files for this change; strict lint + CI contract cover it");
    process.exit(0);
  }
  console.log(`focused-tests: running ${tests.length} related file(s): ${tests.join(", ")}`);
  execFileSync("npx", ["vitest", "run", ...tests], { stdio: "inherit" });
}
