#!/usr/bin/env node
// The external minute watchdog observes queue progress even when the bridge's awaits are stuck.
import { readFileSync, readdirSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { acquireFileLease } from "../core/file-lease.mjs";
import { readTailWindow } from "../core/jsonl-reader.mjs";

const read = path => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } };

/** WHAT: Reads only delivery timestamps and states. WHY: Detects a stalled dispatcher without exposing messages or changing jobs. */
export function deliveryStall({ stateDir, now = Date.now() }) {
  const queueDir = join(stateDir, "delivery-queue"), waiting = [];
  let lastAttempt = 0;
  let dirs;
  try { dirs = readdirSync(queueDir, { withFileTypes: true }); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  for (const dir of dirs.filter(entry => entry.isDirectory())) {
    for (const name of readdirSync(join(queueDir, dir.name)).filter(name => name.endsWith(".json"))) {
      const job = read(join(queueDir, dir.name, name));
      if (!job) continue;
      lastAttempt = Math.max(lastAttempt, Number(job.lastAttemptAt) || 0);
      if (["pending", "delivering"].includes(job.status) && Number(job.createdAt) > 0) waiting.push(job.createdAt);
    }
  }
  // Queue pruning must not erase a more recent attempt in another project.
  const events = readTailWindow(join(stateDir, "events.jsonl"), 1024 * 1024).text;
  for (const line of events.split("\n")) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    if (event.event === "delivery_queue" && ["attempt", "native_attempt"].includes(event.state)) {
      lastAttempt = Math.max(lastAttempt, Date.parse(event.ts) || 0);
    }
  }
  if (!waiting.length) return null;
  const since = Math.max(lastAttempt, Math.min(...waiting));
  return now - since >= 10 * 60_000 ? { episode: String(since), pending: waiting.length, since } : null;
}

/** WHAT: Reports a stalled delivery interval through notifyuser. WHY: Prevents a live heartbeat from hiding a queue that no longer attempts input. */
export function watchDeliveryAttempts({ stateDir = join(process.env.HOME, ".agentmux"), now = Date.now(),
  notify = stall => execFileSync(process.env.AMUX || "amux", ["notifyuser", "--level", "error",
    "--idempotency-key", `delivery-stall:${stall.episode}`,
    `Agentmux: inget leveransförsök på minst 10 min med ${stall.pending} jobb i kö. Kontrollera leveransbryggan.`],
  { timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] }) } = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const lease = acquireFileLease(join(stateDir, ".delivery-stall-watch.lock"));
  if (!lease) return;
  try {
    const path = join(stateDir, "delivery-stall-alert.json"), stall = deliveryStall({ stateDir, now });
    if (stall && read(path)?.episode === stall.episode) return;
    if (stall) notify(stall); // A failed notification remains retryable on the next minute sweep.
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ episode: stall?.episode || null, checkedAt: now }), { mode: 0o600 });
    renameSync(temporary, path);
  } finally { lease.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { watchDeliveryAttempts(); }
  catch (error) { console.error(`delivery-stall-watch: ${error.code || error.name}`); process.exitCode = 1; }
}
