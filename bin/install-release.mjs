#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installRelease,
  verifyInstalledReleaseAgainstRepository,
} from "../core/release-install.mjs";

const USAGE = "Usage: node bin/install-release.mjs --sha FULL_MASTER_SHA [--repo PATH]\n"
  + "   or: node bin/install-release.mjs --verify-installed [--repo PATH] [--package-root PATH]";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (name === "--verify-installed") {
      values.verifyInstalled = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!new Set(["--sha", "--repo", "--package-root"]).has(name) || !value
      || value.startsWith("--")) {
      throw new Error(USAGE);
    }
    values[name === "--package-root" ? "packageRoot" : name.slice(2)] = value;
    index += 2;
  }
  if (values.verifyInstalled) {
    if (values.sha) throw new Error(USAGE);
  } else if (!values.sha || values.packageRoot) {
    throw new Error(USAGE);
  }
  return values;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const defaultRepo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (args.verifyInstalled) {
    const result = verifyInstalledReleaseAgainstRepository({
      repoRoot: args.repo || defaultRepo,
      ...(args.packageRoot ? { packageRoot: args.packageRoot } : {}),
    });
    console.log(`verified installed agentmux ${result.packageVersion || "unknown version"} @ ${result.sourceSha}`);
    console.log(`content: ${result.fileCount} files match origin/master`);
    process.exit(0);
  }
  const result = installRelease({ repoRoot: args.repo || defaultRepo, sourceSha: args.sha });
  console.log(`installed agentmux ${result.packageVersion} @ ${result.sourceSha}`);
  console.log(`binary: ${result.binaryRealpath}`);
  console.log(`receipt: ${result.packageRoot} + ${result.artifactSha256}`);
} catch (error) {
  console.error(`install-release: ${error.message}`);
  process.exit(1);
}
