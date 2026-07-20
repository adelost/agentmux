#!/usr/bin/env node
// Prints the installed release identity decision as JSON and exits non-zero
// when panel revive must be refused. Used by bin/post-boot-revive.sh and by
// humans; the bridge itself is the recovery channel and always allowed.
// Verification is local (manifest + receipt + package bytes + realpaths);
// an unreachable remote master is a warning here, never the blocking check.

import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { identityDecision, observeReleaseIdentity } from "../core/release-identity.mjs";

function main() {
  const packageRoot = join(
    execFileSync("npm", ["root", "--global"], { encoding: "utf8" }).trim(),
    "agentmux",
  );
  const entryPath = join(
    execFileSync("npm", ["prefix", "--global"], { encoding: "utf8" }).trim(),
    "bin",
    "amux",
  );
  const identity = observeReleaseIdentity({
    runtimeRoot: packageRoot,
    entryPath,
    home: homedir(),
  });
  const decision = identityDecision(identity);
  console.log(JSON.stringify({
    ...decision,
    sourceSha: identity.sourceSha,
    packageVersion: identity.packageVersion,
    issues: identity.issues,
    warnings: identity.warnings,
  }, null, 2));
  if (!decision.allowRevive) process.exit(1);
}

main();
