#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pollDiskGuardOnce } from "../core/disk-guard.mjs";
import { maintainDiskCaches,relieveDiskPressure } from "../core/disk-pressure-relief.mjs";
import { loadRuntimeEnv } from "../core/runtime-env.mjs";
import { notifyUser } from "../cli/send-notify.mjs";

if(process.argv.slice(2).join(" ")!=="poll") throw new Error("Usage: disk-guard.mjs poll");
loadRuntimeEnv({packageRoot:resolve(dirname(fileURLToPath(import.meta.url)),"..")});
// The cleanup runs as its own unit: its scans and moves outlast this poll's five-minute deadline.
const startCleanup=async()=>{
  execFileSync("systemctl",["--user","start","--no-block","agentmux-disk-cleanup.service"],{stdio:"ignore",timeout:30000});
  return {started:true};
};
const state=await pollDiskGuardOnce({maintain:maintainDiskCaches,relieve:relieveDiskPressure,notify:notifyUser,startCleanup});
console.log(JSON.stringify({at:state.completedAt,level:state.level,availableBytes:state.after.availableBytes,
  cleanup:state.cleanup,gradleBuildCacheBytes:state.maintenance.gradle.buildCacheBytesAfter,
  gradleHeld:state.maintenance.gradle.errors,reliefActions:state.relief?.actions.length??0}));
