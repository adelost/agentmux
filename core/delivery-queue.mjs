// Durable, process-independent delivery spool.
//
// Every producer (Discord bridge, `amux send`, cron helpers) writes one
// immutable job identity here before any tmux interaction.  The bridge's
// delivery broker is the only normal consumer.  One file per job makes
// enqueue atomic across unrelated Node processes and leaves enough state to
// resume a drafted/submitted prompt after a bridge crash.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { homedir } from "os";
import { basename, dirname, join } from "path";

export const DELIVERY_QUEUE_VERSION = 1;
export const TERMINAL_DELIVERY_STATES = new Set(["acknowledged", "cancelled"]);

export function defaultDeliveryQueueDir() {
  return process.env.AMUX_DELIVERY_QUEUE_DIR
    || join(homedir(), ".agentmux", "delivery-queue");
}

const hashId = (value) => createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
const targetKey = (agentName, pane) => `${encodeURIComponent(agentName)}--p${Number(pane) || 0}`;
const parseJson = (path) => JSON.parse(readFileSync(path, "utf-8"));

function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch {}
}

function atomicReplace(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/**
 * Create a durable queue store. Storage only: it never touches tmux.
 */
export function createDeliveryQueue({
  rootDir = defaultDeliveryQueueDir(),
  now = () => Date.now(),
  uuid = () => randomUUID(),
} = {}) {
  ensurePrivateDir(rootDir);

  const dirFor = (agentName, pane) => join(rootDir, targetKey(agentName, pane));
  const pathFor = (agentName, pane, id) => join(dirFor(agentName, pane), `${id}.json`);

  function persistAssets(text, dir, id) {
    const paths = [...String(text).matchAll(/\[(?:image|file) attached:\s+([^\]\n]+)\]/gi)]
      .map((match) => match[1].trim());
    if (!paths.length) return [];
    const assetDir = join(dir, "assets", id);
    ensurePrivateDir(assetDir);
    return paths.flatMap((original, index) => {
      if (!existsSync(original)) return [];
      const backup = join(assetDir, `${String(index).padStart(2, "0")}-${basename(original)}`);
      copyFileSync(original, backup);
      try { chmodSync(backup, 0o600); } catch {}
      return [{ original, backup }];
    });
  }

  function enqueue({
    agentName,
    pane = 0,
    text,
    verifyText = null,
    kind = null,
    source = "unknown",
    idempotencyKey = null,
    createdAt = null,
    orderKey = null,
    metadata = null,
    echoCursor = null,
  }) {
    if (!agentName) throw new Error("delivery queue requires agentName");
    if (!String(text || "").trim()) throw new Error("delivery queue requires non-empty text");

    const createdAtMs = Number(createdAt) || now();
    const identity = idempotencyKey || `generated:${uuid()}`;
    const id = hashId(identity);
    const paneNumber = Number(pane) || 0;
    const dir = dirFor(agentName, paneNumber);
    const path = pathFor(agentName, paneNumber, id);
    ensurePrivateDir(dir);

    const job = {
      version: DELIVERY_QUEUE_VERSION,
      id,
      idempotencyKey: identity,
      agentName,
      pane: paneNumber,
      text: String(text),
      verifyText: verifyText == null ? String(text) : String(verifyText),
      kind: kind || (/^\/[a-z][\w-]*(\s|$)/i.test(String(text).trimStart()) ? "slash" : "prompt"),
      source,
      createdAt: createdAtMs,
      orderKey: orderKey || `${String(createdAtMs).padStart(16, "0")}:${identity}`,
      status: "pending",
      attempts: 0,
      echoCursor,
      lastAttemptAt: null,
      nextAttemptAt: createdAtMs,
      lastReason: null,
      noticeSentAt: null,
      acknowledgedAt: null,
      metadata: metadata || {},
      assets: persistAssets(text, dir, id),
    };

    // A fully-written temporary inode is hard-linked into its deterministic
    // destination. link(2) is atomic: concurrent Gateway/REST replays either
    // create the job once or read the existing state without resetting it.
    const tmp = join(dir, `.${id}.${process.pid}.${uuid()}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(job, null, 2)}\n`, { mode: 0o600 });
    try {
      linkSync(tmp, path);
      return { ...job, path };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return { ...parseJson(path), path };
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  }

  function read(agentName, pane, id) {
    const path = pathFor(agentName, pane, id);
    try { return { ...parseJson(path), path }; }
    catch { return null; }
  }

  function update(job, patch) {
    const current = read(job.agentName, job.pane, job.id);
    if (!current) throw new Error(`delivery job ${job.id} disappeared`);
    const next = {
      ...current,
      ...patch,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
    };
    delete next.path;
    atomicReplace(current.path, next);
    return { ...next, path: current.path };
  }

  function list(agentName, pane) {
    const dir = dirFor(agentName, pane);
    let names;
    try { names = readdirSync(dir).filter((name) => name.endsWith(".json")); }
    catch { return []; }
    return names.flatMap((name) => {
      const path = join(dir, name);
      try { return [{ ...parseJson(path), path }]; }
      catch { return []; }
    }).sort((a, b) => String(a.orderKey).localeCompare(String(b.orderKey)));
  }

  function next(agentName, pane) {
    return list(agentName, pane).find((job) => !TERMINAL_DELIVERY_STATES.has(job.status)) || null;
  }

  function targets() {
    let names;
    try { names = readdirSync(rootDir, { withFileTypes: true }); }
    catch { return []; }
    const out = [];
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      const match = entry.name.match(/^(.*)--p(\d+)$/);
      if (!match) continue;
      const agentName = decodeURIComponent(match[1]);
      const pane = Number(match[2]);
      if (next(agentName, pane)) out.push({ agentName, pane });
    }
    return out;
  }

  function findById(id) {
    // Scan all pane directories, including terminal-only ones: a CLI caller
    // often polls a job that the bridge acknowledged between two reads.
    let entries;
    try { entries = readdirSync(rootDir, { withFileTypes: true }); }
    catch { return null; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(rootDir, entry.name, `${id}.json`);
      try { return { ...parseJson(path), path }; } catch {}
    }
    return null;
  }

  function restoreAssets(job) {
    let restored = 0;
    for (const asset of job.assets || []) {
      if (!asset?.original || !asset?.backup || existsSync(asset.original) || !existsSync(asset.backup)) continue;
      mkdirSync(dirname(asset.original), { recursive: true });
      copyFileSync(asset.backup, asset.original);
      restored++;
    }
    return restored;
  }

  function acquireLease(path) {
    const token = `${process.pid}:${uuid()}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(path, `${JSON.stringify({ pid: process.pid, token, acquiredAt: now() })}\n`, {
          flag: "wx",
          mode: 0o600,
        });
        return {
          release() {
            try {
              const current = parseJson(path);
              if (current.token === token) unlinkSync(path);
            } catch {}
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let owner = null;
        try { owner = parseJson(path); } catch {}
        let alive = false;
        if (Number(owner?.pid) > 0) {
          try { process.kill(Number(owner.pid), 0); alive = true; }
          catch (probeError) { alive = probeError?.code === "EPERM"; }
        }
        if (alive) return null;
        // A killed bridge cannot release its lease. Remove only a lock whose
        // recorded owner is absent, then retry the atomic create once.
        try { unlinkSync(path); } catch {}
      }
    }
    return null;
  }

  function acquireTargetLease(agentName, pane) {
    const dir = dirFor(agentName, pane);
    ensurePrivateDir(dir);
    return acquireLease(join(dir, ".consumer.lock"));
  }

  // All configured panes for one agent live in the same tmux window. Zoom is
  // window-global, so two otherwise independent pane deliveries can still
  // hide each other's composers. This lease makes the bridge single-writer
  // per tmux session, including across duplicate bridge processes.
  function acquireSessionLease(agentName) {
    return acquireLease(join(rootDir, `.session-${encodeURIComponent(agentName)}.lock`));
  }

  function prune({ acknowledgedOlderThanMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const cutoff = now() - acknowledgedOlderThanMs;
    let removed = 0;
    let entries;
    try { entries = readdirSync(rootDir, { withFileTypes: true }); }
    catch { return 0; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = join(rootDir, entry.name);
      for (const name of readdirSync(dir).filter((value) => value.endsWith(".json"))) {
        const path = join(dir, name);
        try {
          const job = parseJson(path);
          const finishedAt = Number(job.acknowledgedAt || 0);
          if (TERMINAL_DELIVERY_STATES.has(job.status) && finishedAt && finishedAt < cutoff) {
            unlinkSync(path);
            rmSync(join(dir, "assets", job.id), { recursive: true, force: true });
            removed++;
          }
        } catch {
          // A corrupt job is evidence, not disposable state. Leave it for
          // doctor/audit instead of silently deleting the only prompt copy.
        }
      }
    }
    return removed;
  }

  return {
    rootDir, enqueue, read, update, list, next, targets, findById,
    restoreAssets, acquireTargetLease, acquireSessionLease, prune,
  };
}

export async function waitForDeliveryJob(queue, id, {
  timeoutMs = 12_000,
  pollMs = 100,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (true) {
    const job = queue.findById(id);
    if (!job) return null;
    if (TERMINAL_DELIVERY_STATES.has(job.status)) return job;
    if (Date.now() >= deadline) return job;
    await sleep(pollMs);
  }
}

export function deliveryQueueStats(queue) {
  let pending = 0, drafted = 0, submitted = 0, blocked = 0;
  let oldestCreatedAt = null;
  for (const { agentName, pane } of queue.targets()) {
    for (const job of queue.list(agentName, pane)) {
      if (!TERMINAL_DELIVERY_STATES.has(job.status)) {
        const createdAt = Number(job.createdAt || 0);
        if (createdAt && (oldestCreatedAt == null || createdAt < oldestCreatedAt)) oldestCreatedAt = createdAt;
      }
      if (job.status === "pending" || job.status === "delivering") pending++;
      else if (job.status === "drafted") drafted++;
      else if (job.status === "submitted") submitted++;
      else if (job.status === "blocked") blocked++;
    }
  }
  return { pending, drafted, submitted, blocked, total: pending + drafted + submitted + blocked, oldestCreatedAt };
}
