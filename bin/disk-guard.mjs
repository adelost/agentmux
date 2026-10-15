#!/usr/bin/env node
import { dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pollDiskGuardOnce } from "../core/disk-guard.mjs";
import { maintainDiskCaches,relieveDiskPressure } from "../core/disk-pressure-relief.mjs";
import { loadRuntimeEnv } from "../core/runtime-env.mjs";
import { notifyUser } from "../cli/send-notify.mjs";

if(process.argv.slice(2).join(" ")!=="poll") throw new Error("Usage: disk-guard.mjs poll");
loadRuntimeEnv({packageRoot:resolve(dirname(fileURLToPath(import.meta.url)),"..")});
const state=await pollDiskGuardOnce({maintain:maintainDiskCaches,relieve:relieveDiskPressure,notify:notifyUser});
console.log(JSON.stringify({at:state.completedAt,level:state.level,availableBytes:state.after.availableBytes,
  dependencyEntriesRemoved:state.maintenance.dependencies.actions.filter(({mode})=>mode==="removed").length,
  gradleBuildCacheBytes:state.maintenance.gradle.buildCacheBytesAfter,
  gradleHeld:state.maintenance.gradle.errors,reliefActions:state.relief?.actions.length??0}));
