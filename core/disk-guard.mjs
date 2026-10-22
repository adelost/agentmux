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

const HIGH_USE_PERCENT=80;
const NIGHTLY_HOUR=3;
const HIGH_USE_CLEANUP_EVERY_MS=6*3600000;

/** WHAT: Returns used share the way df's Use% does, without the root reserve. WHY: Keeps the 80 % trigger on the number people read in df. */
export const usedPercent=({usedBytes,availableBytes})=>100*usedBytes/(usedBytes+availableBytes);

const localDate=(ms)=>{const date=new Date(ms);return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;};

// Once each night after 03:00, and while use stays at or above 80 % at most every six hours.
/** WHAT: Checks whether this poll starts the cleanup. WHY: Prevents its long scans from repeating every hour. */
export function cleanupDue({sample,previous,nowMs}) {
  const last=previous?.cleanup;
  if(new Date(nowMs).getHours()>=NIGHTLY_HOUR && last?.nightlyDate!==localDate(nowMs)) return "nightly";
  if(usedPercent(sample)>=HIGH_USE_PERCENT && !(nowMs-Date.parse(last?.startedAt??0)<HIGH_USE_CLEANUP_EVERY_MS)) return "high-use";
  return null;
}

/** WHAT: Reads disk, maintains caches, starts the cleanup and applies pressure policy. WHY: Separates normal retention, scheduled cleanup and emergency relief, with one alert per episode. */
export async function pollDiskGuardOnce({sample=sampleRootDisk,readState:read=readState,writeState:write=writeState,
  maintain=async()=>({}),relieve=async()=>({}),notify=async()=>({sent:false}),startCleanup=async()=>({started:false}),now=()=>Date.now()}={}) {
  const before=sample();
  if(!Number.isFinite(before.availableBytes)||before.availableBytes<0) throw new Error("invalid df available bytes");
  const previous=read();
  const pressure=before.availableBytes<100e9, highUse=usedPercent(before)>=HIGH_USE_PERCENT;
  const state={schemaVersion:1,observedAt:new Date(now()).toISOString(),sample:before,
    level:before.availableBytes<30e9?"critical":pressure?"pressure":"normal",
    episode:pressure?(previous?.episode??randomUUID()):null,
    alerted:pressure?Boolean(previous?.alerted):false,
    highUse:highUse?{episode:previous?.highUse?.episode??randomUUID(),alerted:Boolean(previous?.highUse?.alerted)}:null,
    cleanup:previous?.cleanup??null};
  write(state);
  if(highUse&&!state.highUse.alerted) {
    const result=await notify(`Disk guard: / is ${usedPercent(before).toFixed(0)} % used, ${(before.availableBytes/1e9).toFixed(1)} GB free. Starting the cleanup.`,
      {idempotencyKey:`disk-high-use-${state.highUse.episode}`,level:"warning",title:"Root disk"});
    if(result?.sent||result?.deduped) {state.highUse.alerted=true;write(state);}
  }
  const reason=cleanupDue({sample:before,previous,nowMs:now()});
  if(reason) {
    const started=await startCleanup();
    state.cleanup={...state.cleanup,startedAt:new Date(now()).toISOString(),reason,started:Boolean(started?.started),
      ...(reason==="nightly"?{nightlyDate:localDate(now())}:{})};
    write(state);
  }
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
