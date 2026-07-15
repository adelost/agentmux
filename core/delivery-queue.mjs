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
export const DELIVERED_UNVERIFIED_STATE = "delivered_unverified";
export const TERMINAL_DELIVERY_STATES = new Set([
  "acknowledged", "cancelled", DELIVERED_UNVERIFIED_STATE,
]);

export function isNotSentDeliveryJob(job) {
  return job?.status === "cancelled"
    && (job.metadata?.deliveryOutcome === "not-sent"
      || job.metadata?.deliveryTimeout === "pre-submit");
}

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
  const cancelRequestPathFor = (agentName, pane, id) =>
    join(dirFor(agentName, pane), `${id}.cancel-request`);

  function hydrateCancellation(job) {
    if (!job || (job.cancelRequestStatus && job.cancelRequestStatus !== "requested")) return job;
    try {
      const request = parseJson(cancelRequestPathFor(job.agentName, job.pane, job.id));
      return { ...job, ...request, cancelRequestStatus: "requested" };
    } catch {
      return job;
    }
  }

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
      firstAttemptAt: null,
      lastAttemptAt: null,
      nextAttemptAt: createdAtMs,
      lastReason: null,
      noticeSentAt: null,
      cancelRequestStatus: null,
      cancelRequestedAt: null,
      cancelRequestedBy: null,
      cancelRequestedReason: null,
      cancelRequestResolvedAt: null,
      cancelRequestLastReason: null,
      unverifiedNoticeSentAt: null,
      unverifiedNoticeAttempts: 0,
      unverifiedNoticeNextAttemptAt: null,
      unverifiedNoticeLastReason: null,
      acknowledgedAt: null,
      terminalAt: null,
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
      return { ...hydrateCancellation(parseJson(path)), path };
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
  }

  function read(agentName, pane, id) {
    const path = pathFor(agentName, pane, id);
    try { return { ...hydrateCancellation(parseJson(path)), path }; }
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
      try { return [{ ...hydrateCancellation(parseJson(path)), path }]; }
      catch { return []; }
    }).sort((a, b) => String(a.orderKey).localeCompare(String(b.orderKey)));
  }

  function next(agentName, pane) {
    return list(agentName, pane).find((job) => !TERMINAL_DELIVERY_STATES.has(job.status)) || null;
  }

  // A submitted prompt has already left the verified composer. Its JSONL
  // receipt is still pending, but it no longer owns the pane's write slot.
  // Every other non-terminal state remains ordered: in particular a drafted
  // prompt must stay ahead of later work so two payloads can never merge.
  function nextForWrite(agentName, pane) {
    return list(agentName, pane).find((job) =>
      !TERMINAL_DELIVERY_STATES.has(job.status)
        && job.status !== "submitting"
        && job.status !== "submitted") || null;
  }

  function submitted(agentName, pane) {
    return list(agentName, pane)
      .filter((job) => job.status === "submitting" || job.status === "submitted");
  }

  function pendingCancellationRequests(agentName, pane) {
    return list(agentName, pane)
      .filter((job) => job.cancelRequestStatus === "requested");
  }

  function pendingTerminalNotices(agentName, pane) {
    return list(agentName, pane).filter((job) => {
      const needsNotice = job.status === DELIVERED_UNVERIFIED_STATE
        || isNotSentDeliveryJob(job);
      // These field names predate pre-submit dead-lettering. Keep them on disk
      // for schema compatibility; they now fence either terminal notice kind.
      return needsNotice && !job.unverifiedNoticeSentAt;
    });
  }

  function pendingUnverifiedNotices(agentName, pane) {
    return pendingTerminalNotices(agentName, pane)
      .filter((job) => job.status === DELIVERED_UNVERIFIED_STATE);
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
      if (next(agentName, pane)
          || pendingTerminalNotices(agentName, pane).length
          || pendingCancellationRequests(agentName, pane).length) {
        out.push({ agentName, pane });
      }
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
      try { return { ...hydrateCancellation(parseJson(path)), path }; } catch {}
    }
    return null;
  }

  function requestCancellation(id, { reason, requestedBy = "unknown" } = {}) {
    const normalizedReason = String(reason || "").trim();
    if (!normalizedReason) throw new Error("delivery cancellation requires a reason");
    if (normalizedReason.length > 500) {
      throw new Error("delivery cancellation reason must be at most 500 characters");
    }
    const current = findById(String(id || ""));
    if (!current) throw new Error(`delivery job ${id} not found`);

    // Keep the request in its own immutable sidecar. A producer can race a
    // broker job-file update, so storing both in the mutable job would allow
    // the later rename to erase a valid cancellation request.
    if (current.cancelRequestStatus) return current;
    const request = {
      cancelRequestStatus: "requested",
      cancelRequestedAt: now(),
      cancelRequestedBy: String(requestedBy || "unknown").slice(0, 120),
      cancelRequestedReason: normalizedReason,
      cancelRequestResolvedAt: null,
      cancelRequestLastReason: null,
    };
    const path = cancelRequestPathFor(current.agentName, current.pane, current.id);
    const tmp = `${path}.tmp-${process.pid}-${uuid()}`;
    writeFileSync(tmp, `${JSON.stringify(request, null, 2)}\n`, { mode: 0o600 });
    try {
      linkSync(tmp, path);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      try { unlinkSync(tmp); } catch {}
    }
    return read(current.agentName, current.pane, current.id);
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
          const job = hydrateCancellation(parseJson(path));
          const finishedAt = Number(job.acknowledgedAt || job.terminalAt || 0);
          const terminalNoticePending = (job.status === DELIVERED_UNVERIFIED_STATE
              || isNotSentDeliveryJob(job))
            && !job.unverifiedNoticeSentAt;
          const cancellationResolutionPending = job.cancelRequestStatus === "requested";
          if (TERMINAL_DELIVERY_STATES.has(job.status)
              && !terminalNoticePending
              && !cancellationResolutionPending
              && finishedAt
              && finishedAt < cutoff) {
            unlinkSync(path);
            try { unlinkSync(cancelRequestPathFor(job.agentName, job.pane, job.id)); } catch {}
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
    rootDir, enqueue, read, update, list, next, nextForWrite, submitted,
    pendingTerminalNotices, pendingUnverifiedNotices, pendingCancellationRequests,
    requestCancellation, targets, findById,
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
  let pending = 0, pasting = 0, drafted = 0, submitted = 0, blocked = 0;
  let oldestCreatedAt = null;
  for (const { agentName, pane } of queue.targets()) {
    for (const job of queue.list(agentName, pane)) {
      if (!TERMINAL_DELIVERY_STATES.has(job.status)) {
        const createdAt = Number(job.createdAt || 0);
        if (createdAt && (oldestCreatedAt == null || createdAt < oldestCreatedAt)) oldestCreatedAt = createdAt;
      }
      if (job.status === "pending" || job.status === "delivering") pending++;
      else if (job.status === "pasting") pasting++;
      else if (job.status === "drafted") drafted++;
      else if (job.status === "submitting" || job.status === "submitted") submitted++;
      else if (job.status === "blocked") blocked++;
    }
  }
  return {
    pending, pasting, drafted, submitted, blocked,
    total: pending + pasting + drafted + submitted + blocked,
    oldestCreatedAt,
  };
}
