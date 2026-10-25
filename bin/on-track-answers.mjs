#!/usr/bin/env node
import { readWindow } from "../core/ask-ledger.mjs";
import { onTrackStore, onTrackPaths } from "../core/on-track-projects.mjs";
import { ON_TRACK_STATE } from "../core/on-track-monitor.mjs";
import { onTrackAnswerPage } from "../core/on-track-answer-index.mjs";
import { dirname, join } from "node:path";
const id = process.argv[2], cycle = onTrackStore().get(ON_TRACK_STATE)?.projects[id]?.cycle;
if (!cycle || process.argv.length > 4) throw Error("Usage: on-track-answers.mjs PROJECT [CURSOR] with a pending cycle");
const panels = new Set(cycle.asks.map(a => `${a.agent}:${a.pane}`));
const page = onTrackAnswerPage({ root: join(dirname(onTrackPaths().state), "answer-pages"), project: id, cycle, cursor: process.argv[3],
  readEntries: () => readWindow({ since: cycle.sourceWindow?.from ?? cycle.at - 86400000, until: Date.now() }).posts
    .filter(p => panels.has(`${p.agent}:${p.pane}`) && ["reply", "file"].includes(p.kind) && p.status === "sent") });
console.log(JSON.stringify(page));
