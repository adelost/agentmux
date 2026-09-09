#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dreamCatchupCrontab } from "../core/dream-cron-install.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
try {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--dry")) throw new Error("Usage: node bin/install-dream-catchup.mjs [--dry]");
  if (!existsSync(join(root, "bin/dream-catchup.sh"))) throw new Error("catchup entrypoint missing");
  const read = () => execFileSync("crontab", ["-l"], { encoding: "utf8", timeout: 3000 });
  const before = read(), after = dreamCatchupCrontab(before, root);
  if (before === after) console.log("Dream catchup already installed; crontab unchanged.");
  else if (args.includes("--dry")) console.log("Would add one guarded 10-minute catchup. Existing daily schedule and other jobs unchanged.");
  else {
    const backup = join(process.env.HOME, ".agentmux", "cron-backups", `${Date.now()}-${randomUUID()}.crontab`);
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    writeFileSync(backup, before, { mode: 0o600, flag: "wx" });
    if (read() !== before) throw new Error("crontab changed during installation; no update made");
    execFileSync("crontab", ["-"], { input: after, encoding: "utf8", timeout: 3000 });
    if (read() !== after) throw new Error(`crontab readback mismatch; backup at ${backup}`);
    console.log(`Dream catchup installed; original crontab preserved at ${backup}`);
  }
} catch (error) { console.error(`Dream catchup install: ${error.message}`); process.exitCode = 1; }
