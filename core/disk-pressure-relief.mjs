import { execFileSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { applyGradleCacheRetention,sampleRootDisk } from "./disk-cache-retention.mjs";
import { processPathReferences } from "./process-path-references.mjs";

/** WHAT: Collects primary repository cache owners one level deep. WHY: Keeps automatic retention out of disposable worktrees and unrelated user directories. */
export function dependencyCacheRepositories(base=join(homedir(),"lsrc")) {
  return readdirSync(base,{withFileTypes:true}).filter((entry)=>entry.isDirectory())
    .map(({name})=>join(base,name)).filter((path)=>{
      try{return lstatSync(join(path,".git")).isDirectory()&&existsSync(join(path,".agentmux-worktree-deps"));}
      catch(error){if(error.code==="ENOENT")return false;throw error;}
    });
}

/** WHAT: Dispatches hourly Gradle retention. WHY: Keeps build-cache growth bounded between nightly cleanups; dependency entries retire in the nightly cleanup, after its symlink-consumer scan. */
export function maintainDiskCaches() {
  return {gradle:applyGradleCacheRetention({dryRun:false})};
}

/** WHAT: Stores one emergency cache action durably. WHY: Keeps actual df deltas separate from estimated directory sizes. */
function journal(entry) {
  const path=join(homedir(),".agentmux","disk-pressure-actions.jsonl");mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const fd=openSync(path,"a",0o600);
  try{appendFileSync(fd,`${JSON.stringify(entry)}\n`);fsyncSync(fd);}finally{closeSync(fd);}
}

/** WHAT: Reads every process command line. WHY: Lets cache rules see a running install before deleting its cache. */
export const readProcessArgs=()=>execFileSync("ps",["-eo","args="],{encoding:"utf8",maxBuffer:16*1024*1024});

/** WHAT: Collects idle npm and pip caches and Playwright browsers older than the newest of each kind. WHY: Keeps one rule for pressure relief and the nightly cleanup; npx servers and browser profiles are never listed. */
export function packageCacheCandidates({home=homedir(),ps=readProcessArgs()}={}) {
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
  return candidates.filter(existsSync);
}

/** WHAT: Checks that no uv sync, add or pip install runs. WHY: Prevents a prune from removing files an install is writing. */
export const uvPruneAllowed=(ps=readProcessArgs())=>!/\buv\s+(?:sync|add|pip)\b|pip\d?\s+install/u.test(ps);

/** WHAT: Dispatches one idle cache removal with df before and after. WHY: Keeps a held, linked or changed path out and records actual relief, not estimated size. */
export function removeIdleCache(path) {
  const stat=lstatSync(path);
  if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==resolve(path)) return {path,mode:"kept",reason:"not a canonical directory"};
  const safety=processPathReferences([path]);
  if(safety.errors.length||!Array.isArray(safety.holders[path])||safety.holders[path].length) {
    return {path,mode:"kept",reason:"active or unreadable process evidence"};
  }
  const entry={at:new Date().toISOString(),path,before:sampleRootDisk(),mode:"attempting"};journal(entry);
  try{rmSync(path,{recursive:true});entry.mode="removed";}
  catch(error){entry.mode="refused";entry.error=error.message;}
  entry.after=sampleRootDisk();entry.freedBytes=entry.after.availableBytes-entry.before.availableBytes;
  journal(entry);
  return entry;
}

/** WHAT: Dispatches only regenerable cache relief. WHY: Keeps profiles, npx servers, state, media, models and running processes intact. */
export function relieveDiskPressure({home=homedir()}={}) {
  const actions=[];
  for(const path of packageCacheCandidates({home})) {
    if(sampleRootDisk().availableBytes>=100e9) break;
    const entry=removeIdleCache(path);actions.push(entry);
    if(entry.after?.availableBytes>=100e9) break;
  }
  return {actions};
}
