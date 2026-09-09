#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScheduledDream } from "../core/dream-schedule.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => !["--catch-up", "--dry"].includes(arg))) throw new Error("Usage: dream-cron.sh [--catch-up] [--dry]");
  const result = await runScheduledDream({
    workspace: process.env.OPENCLAW_WORKSPACE || process.env.AMUX_WORKSPACE,
    mode: args.includes("--catch-up") ? "catch-up" : "scheduled", dry: args.includes("--dry"),
    run: ({ dateKey, since, token, mode }) => new Promise((resolve, reject) => {
      const child = spawn("/bin/bash", [join(root, "bin/dream-cron.sh"), "--run-scheduled"], {
        stdio: "inherit", env: { ...process.env, AMUX_SCHEDULED_DREAM_DATE: dateKey,
          AMUX_SCHEDULED_DREAM_SINCE: since, AMUX_SCHEDULED_DREAM_TOKEN: token, AMUX_SCHEDULED_DREAM_MODE: mode },
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(signal ? 1 : code ?? 1));
    }),
  });
  if (!result.skipped || !args.includes("--catch-up")) console.log(JSON.stringify(result));
  process.exitCode = result.exitCode || 0;
} catch (error) {
  console.error(`Dream schedule: ${error.message}`);
  process.exitCode = 1;
}
