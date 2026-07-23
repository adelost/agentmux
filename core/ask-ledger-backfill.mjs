// One-time migration from the durable delivery spool into the ask ledger.
//
// The delivery queue predates the ask ledger and already retains exact prompt
// bytes. Reading those immutable job files once closes the historical gap
// without making every `amux asks` invocation rescan the spool.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  appendAskLedger,
  defaultAskLedgerPath,
  readAskLedger,
} from "./ask-ledger.mjs";
import { defaultDeliveryQueueDir, DELIVERY_QUEUE_VERSION } from "./delivery-queue.mjs";
import { inferAskOrigin } from "./ask-origin.mjs";
import { isSystemNoiseDirective } from "./system-noise.mjs";

export const ASK_DELIVERY_BACKFILL_VERSION = 1;

export function defaultAskBackfillMarkerPath(ledgerPath = defaultAskLedgerPath()) {
  return `${ledgerPath}.delivery-backfill-v${ASK_DELIVERY_BACKFILL_VERSION}.json`;
}

function queueJobFiles(rootDir) {
  let targetDirs = [];
  try { targetDirs = readdirSync(rootDir, { withFileTypes: true }); }
  catch { return []; }
  return targetDirs
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const targetDir = join(rootDir, entry.name);
      let files = [];
      try { files = readdirSync(targetDir); } catch { return []; }
      return files
        .filter((name) => name.endsWith(".json"))
        .map((name) => join(targetDir, name));
    })
    .sort();
}

function readMarker(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed?.version === ASK_DELIVERY_BACKFILL_VERSION ? parsed : null;
  } catch {
    return null;
  }
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
  try { chmodSync(path, 0o600); } catch {}
}

function ledgerHasRows(path) {
  try { return statSync(path).size > 0; } catch { return false; }
}

/** WHAT: Imports pre-ledger delivery jobs exactly once. WHY: Old asks must not disappear merely because the ledger feature shipped later. */
export function backfillAskLedgerFromDeliveryQueue({
  queueDir = defaultDeliveryQueueDir(),
  ledgerPath = defaultAskLedgerPath(),
  markerPath = defaultAskBackfillMarkerPath(ledgerPath),
  now = () => Date.now(),
  readLedger = () => readAskLedger({ path: ledgerPath }),
  recordAsk = appendAskLedger,
  force = false,
} = {}) {
  const startedAt = Number(now());
  const marker = readMarker(markerPath);
  if (!force && marker && ledgerHasRows(ledgerPath)) {
    return {
      ...marker,
      markerPath,
      skipped: true,
      elapsedMs: Math.max(0, Number(now()) - startedAt),
    };
  }

  const existing = new Map(readLedger().map((entry) => [entry.id, entry]));
  const files = queueJobFiles(queueDir);
  let imported = 0;
  let enriched = 0;
  let ignored = 0;
  let invalid = 0;

  for (const file of files) {
    let job;
    try { job = JSON.parse(readFileSync(file, "utf8")); }
    catch {
      invalid++;
      continue;
    }
    const prompt = typeof job?.text === "string" ? job.text : "";
    if (job?.version !== DELIVERY_QUEUE_VERSION
        || !job.id
        || !job.agentName
        || !prompt.trim()) {
      invalid++;
      continue;
    }
    if (job.kind === "slash" || isSystemNoiseDirective(prompt)) {
      ignored++;
      continue;
    }

    const id = `delivery:${job.id}`;
    const previous = existing.get(id);
    if (previous?.deliveryPath) continue;
    const sender = job.metadata?.sender || null;
    recordAsk({
      id,
      ts: new Date(Number(job.createdAt) || startedAt).toISOString(),
      agent: job.agentName,
      pane: Number(job.pane) || 0,
      source: job.source || "unknown",
      verbatim: prompt,
      sessionFile: Object.keys(job.echoCursor?.positions || {})[0] || null,
      sessionId: job.metadata?.sessionId || null,
      cwd: job.metadata?.cwd || null,
      repo: job.metadata?.repo || job.agentName,
      deliveryId: job.id,
      deliveryPath: file,
      deliveryStatus: job.status || null,
      origin: inferAskOrigin({ source: job.source, sender, prompt }),
      sender,
      backfilled: true,
    }, { path: ledgerPath, now });
    if (previous) enriched++;
    else imported++;
    existing.set(id, { ...(previous || {}), deliveryPath: file });
  }

  const completedAt = Number(now());
  const result = {
    version: ASK_DELIVERY_BACKFILL_VERSION,
    completedAt: new Date(completedAt).toISOString(),
    scanned: files.length,
    imported,
    enriched,
    ignored,
    invalid,
    elapsedMs: Math.max(0, completedAt - startedAt),
  };
  atomicWrite(markerPath, result);
  return { ...result, markerPath, skipped: false };
}
