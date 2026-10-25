#!/usr/bin/env node
import { readWindow } from "../core/ask-ledger.mjs";
import { onTrackStore } from "../core/on-track-projects.mjs";
import { ON_TRACK_STATE } from "../core/on-track-monitor.mjs";
import { createHash } from "node:crypto";
const id = process.argv[2], cycle = onTrackStore().get(ON_TRACK_STATE)?.projects[id]?.cycle;
if (!cycle || process.argv.length !== 3) throw Error("Usage: on-track-answers.mjs PROJECT with a pending cycle");
const panels = new Set(cycle.asks.map(a => `${a.agent}:${a.pane}`));
const log = readWindow({ since: cycle.sourceWindow?.from ?? cycle.at - 86400000, until: Date.now() });
const answers = log.posts.filter(p => panels.has(`${p.agent}:${p.pane}`) && ["reply", "file"].includes(p.kind) && p.status === "sent")
  .map(p => ({ id: p.id, at: p.ts, agent: p.agent, pane: p.pane, source: p.ledgerPath, messageId: p.messageId,
    text: p.text.slice(0, 4096), textSha256: createHash("sha256").update(p.text).digest("hex") }));
console.log(JSON.stringify({ project: id, cycle: cycle.id, readAt: new Date().toISOString(), answers }));
