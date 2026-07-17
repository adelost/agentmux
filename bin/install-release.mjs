#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installRelease } from "../core/release-install.mjs";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--sha", "--repo"]).has(name) || !value) {
      throw new Error("Usage: node bin/install-release.mjs --sha FULL_MASTER_SHA [--repo PATH]");
    }
    values[name.slice(2)] = value;
  }
  if (!values.sha) throw new Error("--sha is required");
  return values;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = installRelease({ repoRoot: args.repo || defaultRepo, sourceSha: args.sha });
  console.log(`installed agentmux ${result.packageVersion} @ ${result.sourceSha}`);
  console.log(`binary: ${result.binaryRealpath}`);
  console.log(`receipt: ${result.packageRoot} + ${result.artifactSha256}`);
} catch (error) {
  console.error(`install-release: ${error.message}`);
  process.exit(1);
}
