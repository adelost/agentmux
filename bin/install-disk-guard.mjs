#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir,userInfo } from "node:os";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const unitRoot=join(homedir(),".config/systemd/user");
const initRoot=join(homedir(),".gradle/init.d");
mkdirSync(unitRoot,{recursive:true});mkdirSync(initRoot,{recursive:true});
copyFileSync(join(root,"templates/gradle-disk-retention.gradle"),join(initRoot,"agentmux-disk-retention.gradle"));
const node=process.execPath;
const service=`[Unit]\nDescription=Agentmux root disk retention and pressure guard\n\n[Service]\nType=oneshot\nExecStart=/usr/bin/flock -n %t/agentmux-disk-guard.lock ${node} ${root}/bin/disk-guard.mjs poll\nTimeoutStartSec=300\nNice=10\n`;
const timer="[Unit]\nDescription=Check root disk hourly\n\n[Timer]\nOnCalendar=hourly\nPersistent=true\nAccuracySec=1min\n\n[Install]\nWantedBy=timers.target\n";
// Nice and idle I/O keep the nightly scans and the move to Q: behind interactive work.
const cleanup=`[Unit]\nDescription=Agentmux nightly and high-use root disk cleanup\n\n[Service]\nType=oneshot\nEnvironment=PATH=${homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin\nExecStart=/usr/bin/flock -n %t/agentmux-disk-cleanup.lock ${node} ${root}/bin/disk-cleanup.mjs apply\nTimeoutStartSec=8h\nNice=15\nIOSchedulingClass=idle\n`;
writeFileSync(join(unitRoot,"agentmux-disk-guard.service"),service);
writeFileSync(join(unitRoot,"agentmux-disk-cleanup.service"),cleanup);
writeFileSync(join(unitRoot,"agentmux-disk-guard.timer"),timer);
const run=(cmd,args)=>execFileSync(cmd,args,{encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
const linger=run("loginctl",["show-user",userInfo().username,"-p","Linger","--value"]);
if(linger!=="yes") run("sudo",["-n","loginctl","enable-linger",userInfo().username]);
run("systemctl",["--user","daemon-reload"]);
run("systemctl",["--user","enable","--now","agentmux-disk-guard.timer"]);
let cron;
try{cron=run("crontab",["-l"]);}catch(error){if(error.status!==1)throw error;cron="";}
const updated=cron.replace(/# amux-janitor read-only[^\n]*/u,"# amux-janitor safe-worktree-retirement");
if(updated!==cron) execFileSync("crontab",["-"],{input:`${updated}\n`});
console.log(JSON.stringify({installedAt:new Date().toISOString(),packageRoot:root,
  timer:run("systemctl",["--user","is-enabled","agentmux-disk-guard.timer"]),
  next:run("systemctl",["--user","show","agentmux-disk-guard.timer","-p","NextElapseUSecRealtime"]),
  gradleScript:join(initRoot,"agentmux-disk-retention.gradle"),
  gradleBytes:readFileSync(join(initRoot,"agentmux-disk-retention.gradle")).byteLength},null,2));
