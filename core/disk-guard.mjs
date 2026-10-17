import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sampleRootDisk } from "./disk-cache-retention.mjs";

const statePath=()=>join(homedir(),".agentmux","disk-guard.json");

/** WHAT: Reads the durable disk episode. WHY: Keeps process restarts from sending another alert for the same pressure. */
function readState() {
  try {return JSON.parse(readFileSync(statePath(),"utf8"));}
  catch(error) {if(error.code==="ENOENT")return null;throw error;}
}

/** WHAT: Stores one disk sample and episode atomically. WHY: Prevents partial state from reopening an already alerted episode. */
function writeState(state) {
  const path=statePath();mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const temporary=`${path}.${process.pid}.tmp`;
  writeFileSync(temporary,`${JSON.stringify(state,null,2)}\n`,{mode:0o600});renameSync(temporary,path);
}

/** WHAT: Reads disk, maintains caches and applies pressure policy. WHY: Separates normal retention from emergency relief and one-alert-per-episode delivery. */
export async function pollDiskGuardOnce({sample=sampleRootDisk,readState:read=readState,writeState:write=writeState,
  maintain=async()=>({}),relieve=async()=>({}),notify=async()=>({sent:false}),now=()=>Date.now()}={}) {
  const before=sample();
  if(!Number.isFinite(before.availableBytes)||before.availableBytes<0) throw new Error("invalid df available bytes");
  const previous=read();
  const pressure=before.availableBytes<100e9;
  const state={schemaVersion:1,observedAt:new Date(now()).toISOString(),sample:before,
    level:before.availableBytes<30e9?"critical":pressure?"pressure":"normal",
    episode:pressure?(previous?.episode??randomUUID()):null,
    alerted:pressure?Boolean(previous?.alerted):false};
  write(state);
  // Alert the observed critical condition before relief can consume time or fail.
  if(state.level==="critical"&&!state.alerted) {
    const result=await notify(`Disk guard: ${(before.availableBytes/1e9).toFixed(1)} GB free on /. Trying to free cache space.`,
      {idempotencyKey:`disk-pressure-${state.episode}`,level:"error",title:"Root disk"});
    if(result?.sent||result?.deduped) {state.alerted=true;write(state);}
  }
  state.maintenance=await maintain();
  if(pressure) state.relief=await relieve();
  state.after=sample();state.completedAt=new Date(now()).toISOString();write(state);
  return state;
}
