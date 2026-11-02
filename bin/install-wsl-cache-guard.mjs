#!/usr/bin/env node
// Install the cache guard without stopping the running bridge or any pane.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const units = join(homedir(), ".config/systemd/user");
mkdirSync(units, { recursive: true });
const unit = `[Unit]\nDescription=Agentmux WSL page-cache pressure guard\n\n[Service]\nExecStart=/usr/bin/flock -n %t/agentmux-wsl-cache-guard.lock ${process.execPath} ${root}/bin/memory-guard.mjs watch-cache\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
writeFileSync(join(units, "agentmux-wsl-cache-guard.service"), unit);
execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
execFileSync("systemctl", ["--user", "enable", "--now", "agentmux-wsl-cache-guard.service"], { stdio: "inherit" });
