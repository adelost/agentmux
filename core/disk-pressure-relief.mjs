import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyDependencyCacheRetention,applyGradleCacheRetention,sampleRootDisk } from "./disk-cache-retention.mjs";
import { processPathReferences } from "./process-path-references.mjs";

/** WHAT: Collects primary repository cache owners one level deep. WHY: Keeps automatic retention out of disposable worktrees and unrelated user directories. */
export function dependencyCacheRepositories(base=join(homedir(),"lsrc")) {
  return readdirSync(base,{withFileTypes:true}).filter((entry)=>entry.isDirectory())
    .map(({name})=>join(base,name)).filter((path)=>{
      try{return lstatSync(join(path,".git")).isDirectory()&&existsSync(join(path,".agentmux-worktree-deps"));}
      catch(error){if(error.code==="ENOENT")return false;throw error;}
    });
}

/** WHAT: Dispatches normal dependency and Gradle retention. WHY: Keeps cache growth bounded before free space becomes critical. */
export function maintainDiskCaches() {
  return {dependencies:applyDependencyCacheRetention({repositoryRoots:dependencyCacheRepositories(),dryRun:false}),
    gradle:applyGradleCacheRetention({dryRun:false})};
}

/** WHAT: Stores one emergency cache action durably. WHY: Keeps actual df deltas separate from estimated directory sizes. */
function journal(entry) {
  const path=join(homedir(),".agentmux","disk-pressure-actions.jsonl");mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const fd=openSync(path,"a",0o600);
  try{appendFileSync(fd,`${JSON.stringify(entry)}\n`);fsyncSync(fd);}finally{closeSync(fd);}
}

/** WHAT: Dispatches only regenerable cache relief. WHY: Keeps profiles, npx servers, state, media, models and running processes intact. */
export function relieveDiskPressure({home=homedir()}={}) {
  const ps=execFileSync("ps",["-eo","args="],{encoding:"utf8",maxBuffer:16*1024*1024});
  const candidates=[];
  if(!/(?:npm|pnpm)\s+(?:ci|install)|pip\d?\s+install/u.test(ps)) {
    candidates.push(join(home,".npm/_cacache"),join(home,".cache/pip"));
  }
  const browsers=join(home,".cache/ms-playwright");
  if(existsSync(browsers)) {
    const names=readdirSync(browsers).filter((name)=>/^chromium(?:_headless_shell)?-\d+$/u.test(name));
    for(const flavor of ["chromium-","chromium_headless_shell-"]) {
      const versions=names.filter((name)=>name.startsWith(flavor)).sort((a,b)=>Number(b.split("-").at(-1))-Number(a.split("-").at(-1)));
      for(const name of versions.slice(1)) if(!ps.includes(join(browsers,name))) candidates.push(join(browsers,name));
    }
  }
  const actions=[];
  for(const path of candidates.filter(existsSync)) {
    if(sampleRootDisk().availableBytes>=100e9) break;
    const stat=lstatSync(path);
    if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==resolve(path)) continue;
    const safety=processPathReferences([path]);
    if(safety.errors.length||!Array.isArray(safety.holders[path])||safety.holders[path].length) {
      actions.push({path,mode:"kept",reason:"active or unreadable process evidence"});continue;
    }
    const entry={at:new Date().toISOString(),path,before:sampleRootDisk(),mode:"attempting"};journal(entry);
    try{rmSync(path,{recursive:true});entry.mode="removed";}
    catch(error){entry.mode="refused";entry.error=error.message;}
    entry.after=sampleRootDisk();entry.freedBytes=entry.after.availableBytes-entry.before.availableBytes;
    journal(entry);actions.push(entry);
    if(entry.after.availableBytes>=100e9) break;
  }
  return {actions};
}
