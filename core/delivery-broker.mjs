// Single-writer delivery broker.
//
// Producers persist jobs through delivery-queue.mjs.  This broker is the only
// normal tmux writer while the bridge is running. It serializes every source
// per pane, keeps a drafted prompt at the head of the FIFO until it is either
// submitted or acknowledged, and resumes the same job after a bridge restart.

import { appendEvent } from "./events.mjs";
import { deliverToPane } from "./delivery.mjs";
import { waitForDeliveryJob } from "./delivery-queue.mjs";

const ACTIVE_RETRY_MS = 1_000;
const BLOCKED_RETRY_MS = 3_000;
const MAX_BLOCKED_RETRY_MS = 60_000;
const NOTICE_AFTER_MS = 10_000;

function blockedRetryMs(job, { drafted = false } = {}) {
  const base = drafted ? 5_000 : BLOCKED_RETRY_MS;
  const exponent = Math.min(5, Math.max(0, Number(job.attempts || 1) - 1));
  return Math.min(MAX_BLOCKED_RETRY_MS, base * (2 ** exponent));
}

function needsZoomFallback(result, submitted) {
  return Boolean(result?.zoomRecoverable && !result.delivered && !submitted);
}

function queueEvent(job, state, extra = {}) {
  try {
    appendEvent({
      ts: new Date().toISOString(),
      event: "delivery_queue",
      session: job.agentName,
      pane: job.pane,
      state,
      jobId: job.id,
      source: job.source,
      detail: String(job.verifyText || job.text || "").slice(0, 120),
      ...extra,
    });
  } catch { /* diagnostics must never stop the queue */ }
}

/**
 * @param {{agent: object, queue: object, notify?: Function, intervalMs?: number, now?: Function, log?: Function}} options
 */
export function createDeliveryBroker({
  agent,
  queue,
  notify = async () => {},
  intervalMs = 500,
  now = () => Date.now(),
  log = (message) => console.warn(message),
} = {}) {
  if (!agent) throw new Error("delivery broker requires agent");
  if (!queue) throw new Error("delivery broker requires queue");

  const lanes = new Map();
  let timer = null;
  let started = false;
  let stopped = false;

  // Panes share one tmux window. A tiled delivery that cannot render its
  // composer may temporarily zoom the target as a fallback; therefore the
  // in-process critical section remains session-wide even though FIFO
  // ordering is per pane.
  const laneKey = (agentName) => String(agentName);

  function runExclusive(agentName, pane, work) {
    const key = laneKey(agentName);
    const previous = lanes.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    let tracked;
    tracked = next.finally(() => {
      if (lanes.get(key) === tracked) lanes.delete(key);
    });
    lanes.set(key, tracked);
    return tracked;
  }

  async function acknowledge(job, via = "echo") {
    const current = queue.read(job.agentName, job.pane, job.id) || job;
    const acknowledged = queue.update(current, {
      status: "acknowledged",
      acknowledgedAt: now(),
      nextAttemptAt: null,
      lastReason: null,
    });
    queueEvent(acknowledged, "acknowledged", { via });
    if (acknowledged.noticeSentAt) {
      await notify(acknowledged, "recovered").catch((error) =>
        log(`delivery broker recovery notice failed for ${acknowledged.id}: ${error.message}`));
    }
    return acknowledged;
  }

  async function exactEcho(job) {
    if (job.kind !== "prompt" || (!job.echoCursor && !job.echoNotBeforeMs)) return false;
    try {
      return await agent.waitForPromptEcho(
        job.agentName,
        job.pane,
        job.verifyText,
        0,
        job.echoCursor
          ? { cursor: job.echoCursor }
          : { notBeforeMs: job.echoNotBeforeMs },
      );
    } catch {
      return false;
    }
  }

  async function maybeNotifyBlocked(job) {
    if (job.noticeSentAt || now() - Number(job.createdAt || 0) < NOTICE_AFTER_MS) return job;
    const noticed = queue.update(job, { noticeSentAt: now() });
    await notify(noticed, "blocked").catch((error) =>
      log(`delivery broker blocked notice failed for ${noticed.id}: ${error.message}`));
    return noticed;
  }

  async function processJob(initialJob) {
    let job = queue.read(initialJob.agentName, initialJob.pane, initialJob.id) || initialJob;
    queue.restoreAssets?.(job);

    // Persist a same-host timestamp before the first possible tmux write.
    // Event-identity cursors are stronger, but a fresh/missing JSONL can make
    // cursor capture return null; without this fallback a later real echo
    // would be invisible after restart and the broker could retype it.
    if (job.kind === "prompt" && !job.echoNotBeforeMs) {
      job = queue.update(job, { echoNotBeforeMs: now() });
    }

    if (!job.echoCursor && job.kind === "prompt") {
      const cursor = await agent.capturePromptEchoCursor(job.agentName, job.pane, job.verifyText)
        .catch((error) => {
          log(`delivery broker cursor failed for ${job.agentName}:${job.pane}: ${error.message}`);
          return null;
        });
      if (cursor) job = queue.update(job, { echoCursor: cursor });
    }

    // Every resume/retry starts at the authoritative sink. A crash after
    // Enter but before the job file update is therefore acknowledged without
    // retyping the prompt.
    if (await exactEcho(job)) return acknowledge(job, "echo");

    // Once the exact draft left the composer, never type it again merely
    // because JSONL is late. Keep the FIFO head here until Codex records it.
    if (job.status === "submitted") {
      // Slash commands intentionally have no JSONL user event. The durable
      // submitted transition is their terminal proof after a crash between
      // composer verification and the final acknowledged file update.
      if (job.kind === "slash") return acknowledge(job, "slash-submit-recovery");
      const submittedAge = now() - Number(job.submittedAt || job.lastAttemptAt || job.createdAt || now());
      if (submittedAge >= 5_000 && typeof agent.promptTransportState === "function") {
        const transport = await agent.promptTransportState(job.agentName, job.pane, job.text)
          .catch(() => ({ state: "hidden" }));
        if (transport.state === "drafted") {
          return queue.update(job, {
            status: "drafted",
            draftOwned: true,
            nextAttemptAt: now(),
            lastReason: "submitted draft resurfaced before JSONL acknowledgement",
          });
        }
        if (transport.state === "empty-idle") {
          // Empty composer + absent JSONL is ambiguous: Enter may have queued
          // the prompt while Codex is rotating/replaying its rollout. Retyping
          // here produced 22 copies of one long skydive prompt. Submitted is
          // therefore a permanent no-paste fence; only JSONL may advance it.
          return queue.update(job, {
            status: "submitted",
            draftOwned: false,
            nextAttemptAt: now() + BLOCKED_RETRY_MS,
            lastReason: "submission has no JSONL receipt yet; refusing duplicate paste",
          });
        }
        if (transport.state === "foreign") {
          job = queue.update(job, {
            lastReason: `waiting behind a different composer draft: ${transport.detail || "unknown"}`,
          });
          return maybeNotifyBlocked(job);
        }
      }
      return queue.update(job, { nextAttemptAt: now() + ACTIVE_RETRY_MS });
    }

    let drafted = Boolean(job.draftOwned);
    let submitted = false;
    job = queue.update(job, {
      status: drafted ? "drafted" : "delivering",
      attempts: Number(job.attempts || 0) + 1,
      lastAttemptAt: now(),
      nextAttemptAt: null,
    });
    queueEvent(job, "attempt", { attempt: job.attempts });

    const attemptDelivery = async () => {
      try {
        return await deliverToPane(agent, job.agentName, job.pane, job.text, {
          verifyText: job.verifyText,
          attempts: 1,
          echoTimeoutMs: 3_000,
          echoCursor: job.echoCursor,
          notBeforeMs: job.echoCursor ? null : job.echoNotBeforeMs,
          precheckEcho: true,
          knownDrafted: drafted,
          suppressReceipt: true,
          onDrafted: async () => {
            drafted = true;
            const current = queue.read(job.agentName, job.pane, job.id) || job;
            job = queue.update(current, { status: "drafted", draftOwned: true });
            queueEvent(job, "drafted");
          },
          onSubmitted: async () => {
            submitted = true;
            const current = queue.read(job.agentName, job.pane, job.id) || job;
            job = queue.update(current, {
              status: "submitted",
              draftOwned: false,
              submittedAt: now(),
              nextAttemptAt: now() + ACTIVE_RETRY_MS,
            });
            queueEvent(job, "submitted");
          },
          log: (message) => log(`delivery ${job.agentName}:${job.pane} ${job.id}: ${message}`),
        });
      } catch (error) {
        return {
          delivered: false,
          blocked: true,
          reason: error.message,
          ...(error.zoomRecoverable ? { zoomRecoverable: true } : {}),
        };
      }
    };

    // Preserve the visible tiled layout on the normal path. Only a concrete
    // layout-shaped composer failure earns one zoomed retry. If the first
    // attempt already pasted the prompt, `drafted` is durable and the retry
    // recovers that exact draft instead of typing it a second time.
    let result = await attemptDelivery();
    if (needsZoomFallback(result, submitted)
        && typeof agent.zoomPaneForPicker === "function") {
      let zoomReceipt = null;
      try {
        zoomReceipt = await agent.zoomPaneForPicker(job.agentName, job.pane);
        queueEvent(job, "zoom_fallback", { reason: String(result.reason || "").slice(0, 160) });
        result = await attemptDelivery();
      } catch (error) {
        result = {
          delivered: false,
          blocked: true,
          reason: error.message,
          ...(error.zoomRecoverable ? { zoomRecoverable: true } : {}),
        };
      } finally {
        if (typeof agent.restorePaneZoom === "function") {
          await agent.restorePaneZoom(job.agentName, job.pane, zoomReceipt)
            .catch((error) => log(`delivery zoom restore failed for ${job.agentName}:${job.pane}: ${error.message}`));
        }
      }
    }

    job = queue.read(job.agentName, job.pane, job.id) || job;
    if (result.delivered && job.kind === "slash") return acknowledge(job, "slash");
    if (result.delivered && result.via === "echo") return acknowledge(job, "echo");
    if (submitted || result.via === "queue" || result.via === "submit") {
      if (job.status !== "submitted") {
        job = queue.update(job, {
          status: "submitted",
          draftOwned: false,
          submittedAt: now(),
          nextAttemptAt: now() + ACTIVE_RETRY_MS,
        });
      }
      return job;
    }

    const reason = result.reason || "prompt has not reached the agent yet";
    job = queue.update(job, {
      status: drafted ? "drafted" : "blocked",
      draftOwned: drafted,
      lastReason: reason,
      nextAttemptAt: now() + blockedRetryMs(job, { drafted }),
    });
    queueEvent(job, "blocked", { reason: String(reason).slice(0, 160) });
    return maybeNotifyBlocked(job);
  }

  async function drainTarget(agentName, pane) {
    const acquireLease = queue.acquireSessionLease || queue.acquireTargetLease;
    const lease = acquireLease?.(agentName, pane) || null;
    if (acquireLease && !lease) return;
    try {
      while (!stopped) {
        const job = queue.next(agentName, pane);
        if (!job) return;
        if (Number(job.nextAttemptAt || 0) > now()) return;
        const outcome = await processJob(job);
        if (outcome.status !== "acknowledged") return;
        // The head was acknowledged; continue synchronously to the next FIFO
        // item while this lane is still exclusively owned.
      }
    } finally {
      lease?.release();
    }
  }

  function kickTarget(agentName, pane) {
    if (stopped) return Promise.resolve();
    return runExclusive(agentName, pane, () => drainTarget(agentName, pane));
  }

  async function kick() {
    if (stopped) return;
    await Promise.all(queue.targets().map(({ agentName, pane }) => kickTarget(agentName, pane)));
  }

  function enqueue(request) {
    const job = queue.enqueue(request);
    queueEvent(job, "enqueued");
    if (started) {
      void kickTarget(job.agentName, job.pane).catch((error) =>
        log(`delivery broker kick failed for ${job.agentName}:${job.pane}: ${error.message}`));
    }
    return job;
  }

  async function enqueueAndWait(request, { timeoutMs = 12_000 } = {}) {
    const accepted = enqueue(request);
    const job = await waitForDeliveryJob(queue, accepted.id, { timeoutMs }) || accepted;
    return {
      job,
      delivered: job.status === "acknowledged",
      pending: job.status !== "acknowledged" && job.status !== "cancelled",
      cancelled: job.status === "cancelled",
      reason: job.lastReason || null,
    };
  }

  function start() {
    if (timer) return;
    started = true;
    stopped = false;
    queue.prune();
    timer = setInterval(() => {
      kick().catch((error) => log(`delivery broker poll failed: ${error.message}`));
    }, intervalMs);
    timer.unref?.();
    void kick();
  }

  async function stop() {
    started = false;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    await Promise.allSettled([...lanes.values()]);
  }

  return { queue, enqueue, enqueueAndWait, start, stop, kick, kickTarget, runExclusive };
}
