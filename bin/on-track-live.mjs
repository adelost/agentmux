#!/usr/bin/env node
import { readOnTrackProjects } from "../core/on-track-projects.mjs";
import { readLatestOnTrackLive } from "../core/on-track-live.mjs";
const project = readOnTrackProjects().find(p => p.id === process.argv[2]);
if (!project || process.argv.length !== 3) throw Error("Usage: on-track-live.mjs PROJECT");
const result = await readLatestOnTrackLive(project);
console.log(JSON.stringify(result));
if (result.error) process.exitCode = 1;
