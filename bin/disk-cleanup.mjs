#!/usr/bin/env node
// Nightly and high-use root-disk cleanup. "plan" is the dry run; "apply" acts.
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatCleanupRows, runDiskCleanup } from "../core/disk-cleanup.mjs";

const mode = process.argv.slice(2).join(" ");
if (mode !== "plan" && mode !== "apply") throw new Error("Usage: disk-cleanup.mjs plan|apply");
const result = runDiskCleanup({ dryRun: mode === "plan" });
const folder = join(homedir(), ".agentmux", "disk-cleanup");
mkdirSync(folder, { recursive: true, mode: 0o700 });
const path = join(folder, `${result.at.replaceAll(":", "")}-${mode}.json`);
writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log([...formatCleanupRows(result), `Full result: ${path}`].join("\n"));
