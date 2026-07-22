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
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { createHash, randomUUID } from "crypto";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { appendAskLedger, defaultAskLedgerPath } from "./ask-ledger.mjs";

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

/** A terminal job remains operationally live until its sender saw the receipt. */
export function needsDeliveryTerminalNotice(job) {
  return (job?.status === DELIVERED_UNVERIFIED_STATE || isNotSentDeliveryJob(job))
    && !job?.unverifiedNoticeSentAt;
}

// Each unacknowledged receipt budget costs a full hour, so a target that cannot
// ingest drains one message per hour while producers enqueue many more. Two
// budgets burned back to back is two hours of proof; one is not, because a long
// turn can legitimately hold a prompt in the composer past a single budget.
export const NOT_INGESTING_UNVERIFIED_STREAK = 2;

/**
 * Evidence about a delivery target rather than any single job: receipt budgets
 * that expired with nothing ingested since the last acknowledgement. Only an
 * acknowledgement ends the streak, so NOT SENT terminals raised in response to
 * the streak cannot mask it, and a pane that starts consuming again clears its
 * own state with no operator action.
 */
export function unverifiedStreakSinceLastReceipt(jobs) {
  const lastReceiptAt = jobs.reduce((latest, job) => (job.status === "acknowledged"
    ? Math.max(latest, Number(job.acknowledgedAt || job.terminalAt || 0))
    : latest), 0);
  return jobs.filter((job) => job.status === DELIVERED_UNVERIFIED_STATE
    && Number(job.terminalAt || 0) > lastReceiptAt).length;
}

/** A target that has re-proven the same failure is not a target that is draining. */
export function isTargetProvenNotIngesting(jobs) {
  return unverifiedStreakSinceLastReceipt(jobs) >= NOT_INGESTING_UNVERIFIED_STREAK;
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
  askLedgerPath = rootDir === defaultDeliveryQueueDir()
    ? defaultAskLedgerPath()
    : join(rootDir, "ask-ledger.jsonl"),
  recordAsk = appendAskLedger,
  now = () => Date.now(),
  uuid = () => randomUUID(),
  validateTarget = null,
  onListJobRead = null,
} = {}) {
  ensurePrivateDir(rootDir);

  const dirFor = (agentName, pane) => join(rootDir, targetKey(agentName, pane));
  const pathFor = (agentName, pane, id) => join(dirFor(agentName, pane), `${id}.json`);
  const cancelRequestPathFor = (agentName, pane, id) =>
    join(dirFor(agentName, pane), `${id}.cancel-request`);
  const revisionPathFor = (agentName, pane) => join(dirFor(agentName, pane), ".queue-revision");
  const listCache = new Map();

  function cacheKey(agentName, pane) {
    return targetKey(agentName, pane);
  }

  function readRevision(agentName, pane) {
    const signature = (path) => {
      try {
        const stat = statSync(path, { bigint: true });
        return `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.size}`;
      } catch {
        return "missing";
      }
    };
    // The directory signature closes the crash window between persisting a
    // job/sidecar and advancing .queue-revision. Session leases live at the
    // queue root, so a stable target directory really does mean stable jobs.
    return `${signature(revisionPathFor(agentName, pane))}|${signature(dirFor(agentName, pane))}`;
  }

  function markChanged(agentName, pane) {
    const paneNumber = Number(pane) || 0;
    const dir = dirFor(agentName, paneNumber);
    ensurePrivateDir(dir);
    atomicReplace(revisionPathFor(agentName, paneNumber), `${process.pid}:${uuid()}`);
    listCache.delete(cacheKey(agentName, paneNumber));
  }

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

    // This is the last shared boundary before any target-specific durable
    // artifact is created. Producers may validate earlier for clearer UX, but
    // retries and alternate producers must still re-read their current config
    // here so an unknown session/pane can never become an immortal spool lane.
    if (typeof validateTarget === "function") validateTarget(agentName, pane);

    const createdAtMs = Number(createdAt) || now();
    const identity = idempotencyKey || `generated:${uuid()}`;
    const id = hashId(identity);
    const paneNumber = Number(pane) || 0;
    const dir = dirFor(agentName, paneNumber);
    const path = pathFor(agentName, paneNumber, id);

    // The ask archive is the first durable artifact. Keep this before kind
    // classification and target spool creation so a crash cannot deliver a
    // prompt that durable history never observed.
    recordAsk({
      id: `delivery:${id}`,
      ts: new Date(createdAtMs).toISOString(),
      agent: agentName,
      pane: paneNumber,
      source,
      verbatim: String(text),
      sessionFile: metadata?.sessionFile || null,
      sessionId: metadata?.sessionId || null,
      cwd: metadata?.cwd || null,
      repo: metadata?.repo || agentName,
      deliveryId: id,
    }, { path: askLedgerPath, now });

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
      markChanged(agentName, paneNumber);
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
    markChanged(current.agentName, current.pane);
    return { ...next, path: current.path };
  }

  const operationalJob = (job) => !TERMINAL_DELIVERY_STATES.has(job.status)
    || needsDeliveryTerminalNotice(job)
    || job.cancelRequestStatus === "requested";

  function listInternal(agentName, pane, { targetScan = false } = {}) {
    const dir = dirFor(agentName, pane);
    const key = cacheKey(agentName, pane);

    // Producers and the broker are separate processes. Every queue mutation
    // advances this tiny durable revision, so an idle broker can poll it
    // without reopening and parsing thousands of immutable terminal jobs.
    // A target without a revision is legacy state; its directory metadata is
    // still a cross-process invalidation signal until the first mutation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const revisionBefore = readRevision(agentName, pane);
      const cached = listCache.get(key);
      if (cached && cached.revision === revisionBefore) {
        if (cached.jobs) return cached.jobs;
        if (targetScan && cached.operational === false) return [];
      }

      let names;
      try { names = readdirSync(dir).filter((name) => name.endsWith(".json")); }
      catch {
        listCache.delete(key);
        return [];
      }
      const jobs = names.flatMap((name) => {
        const path = join(dir, name);
        try {
          if (typeof onListJobRead === "function") onListJobRead(path);
          return [{ ...hydrateCancellation(parseJson(path)), path }];
        } catch {
          return [];
        }
      }).sort((a, b) => String(a.orderKey).localeCompare(String(b.orderKey)));
      const revisionAfter = readRevision(agentName, pane);
      if (revisionAfter === revisionBefore) {
        const operational = jobs.some(operationalJob);
        // Terminal history can contain large prompt bodies and attachments.
        // The 500 ms target poll needs only the negative result, not thousands
        // of parsed objects retained forever. Keep full jobs only for a live
        // target or an explicit list() caller.
        listCache.set(key, {
          revision: revisionAfter,
          operational,
          jobs: targetScan && !operational ? null : jobs,
        });
        return jobs;
      }
    }

    // Continuous concurrent writers are rare. Return a fresh coherent-enough
    // view but do not cache it; the next 500 ms broker poll retries.
    return readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => {
      const path = join(dir, name);
      try {
        if (typeof onListJobRead === "function") onListJobRead(path);
        return [{ ...hydrateCancellation(parseJson(path)), path }];
      } catch {
        return [];
      }
    }).sort((a, b) => String(a.orderKey).localeCompare(String(b.orderKey)));
  }

  function list(agentName, pane) {
    return listInternal(agentName, pane);
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
    // These field names predate pre-submit dead-lettering. Keep them on disk
    // for schema compatibility; they now fence either terminal notice kind.
    return list(agentName, pane).filter(needsDeliveryTerminalNotice);
  }

  function pendingUnverifiedNotices(agentName, pane) {
    return pendingTerminalNotices(agentName, pane)
      .filter((job) => job.status === DELIVERED_UNVERIFIED_STATE);
  }

  function allTargets() {
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
      out.push({ agentName, pane });
    }
    return out;
  }

  function targets() {
    return allTargets().filter(({ agentName, pane }) =>
      listInternal(agentName, pane, { targetScan: true }).some(operationalJob));
  }

  function findById(id) {
    // Scan all pane directories, including terminal-only ones: a CLI caller
    // often polls a job that the bridge acknowledged between two reads.
    const normalizedId = String(id || "");
    if (!/^[a-f0-9]{32}$/.test(normalizedId)) return null;
    let entries;
    try { entries = readdirSync(rootDir, { withFileTypes: true }); }
    catch { return null; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(rootDir, entry.name, `${normalizedId}.json`);
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
      markChanged(current.agentName, current.pane);
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
      let changed = false;
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
            changed = true;
          }
        } catch {
          // A corrupt job is evidence, not disposable state. Leave it for
          // doctor/audit instead of silently deleting the only prompt copy.
        }
      }
      if (changed) {
        const match = entry.name.match(/^(.*)--p(\d+)$/);
        if (match) markChanged(decodeURIComponent(match[1]), Number(match[2]));
      }
    }
    return removed;
  }

  return {
    rootDir, enqueue, read, update, list, next, nextForWrite, submitted,
    pendingTerminalNotices, pendingUnverifiedNotices, pendingCancellationRequests,
    requestCancellation, targets, allTargets, findById,
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
  let pendingNotices = 0, cancellationRequests = 0;
  let oldestCreatedAt = null;
  let oldestJob = null;
  const notIngestingTargets = [];
  for (const { agentName, pane } of queue.targets()) {
    const jobs = queue.list(agentName, pane);
    const unverifiedStreak = unverifiedStreakSinceLastReceipt(jobs);
    if (unverifiedStreak >= NOT_INGESTING_UNVERIFIED_STREAK) {
      notIngestingTargets.push({ agentName, pane, unverifiedStreak });
    }
    for (const job of jobs) {
      const nonTerminal = !TERMINAL_DELIVERY_STATES.has(job.status);
      const noticePending = needsDeliveryTerminalNotice(job);
      const cancellationPending = job.cancelRequestStatus === "requested";
      if (nonTerminal || noticePending || cancellationPending) {
        const createdAt = Number(job.createdAt || 0);
        const stableTieBreak = createdAt === oldestCreatedAt
          && String(job.id).localeCompare(String(oldestJob?.id || "")) < 0;
        if (createdAt && (oldestCreatedAt == null || createdAt < oldestCreatedAt || stableTieBreak)) {
          oldestCreatedAt = createdAt;
          oldestJob = {
            id: job.id,
            agentName: job.agentName,
            pane: job.pane,
            status: job.status,
            createdAt,
          };
        }
      }
      if (noticePending) pendingNotices++;
      if (cancellationPending) cancellationRequests++;
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
    pendingNotices,
    cancellationRequests,
    oldestCreatedAt,
    oldestJob,
    notIngestingTargets,
  };
}
