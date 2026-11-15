#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const units = join(homedir(), ".config/systemd/user");
mkdirSync(units, { recursive: true });
writeFileSync(join(units, "agentmux-push-wait.service"), `[Unit]\nDescription=Agentmux push wait watch\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/flock -n %t/agentmux-push-wait.lock ${process.execPath} ${root}/bin/push-wait-watch.mjs poll\nTimeoutStartSec=180\nNice=10\n`);
writeFileSync(join(units, "agentmux-push-wait.timer"), "[Unit]\nDescription=Check push wait every ten minutes\n\n[Timer]\nOnCalendar=*:0/10\nPersistent=true\nAccuracySec=1s\n\n[Install]\nWantedBy=timers.target\n");
execFileSync("systemctl", ["--user", "daemon-reload"]);
execFileSync("systemctl", ["--user", "enable", "--now", "agentmux-push-wait.timer"]);
console.log("installed agentmux-push-wait.timer");
