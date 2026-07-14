// Single-writer delivery broker.
//
// Producers persist jobs through delivery-queue.mjs.  This broker is the only
// normal tmux writer while the bridge is running. It serializes every source
// per pane, keeps an unacknowledged prompt at the head of the FIFO, and
// resumes it after a bridge restart. A durable submitted transition is an
// at-most-once fence, not delivery truth: only JSONL acknowledgement releases
// the next physical prompt write.

import { appendEvent } from "./events.mjs";
import { deliverToPane } from "./delivery.mjs";
import {
  DELIVERED_UNVERIFIED_STATE, TERMINAL_DELIVERY_STATES, waitForDeliveryJob,
} from "./delivery-queue.mjs";

const ACTIVE_RETRY_MS = 1_000;
const BLOCKED_RETRY_MS = 3_000;
const MAX_BLOCKED_RETRY_MS = 60_000;
const NOTICE_AFTER_MS = 10_000;
const STALE_SUBMITTED_TERMINAL_MS = 60 * 60 * 1_000;

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
 * @param {{agent: object, queue: object, notify?: Function, resolveNotificationChannel?: Function, validateTarget?: Function, intervalMs?: number, now?: Function, log?: Function}} options
 */
export function createDeliveryBroker({
  agent,
  queue,
  notify = async () => {},
  resolveNotificationChannel = null,
  validateTarget = null,
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

  async function notifyUnverified(initialJob) {
    let current = queue.read(initialJob.agentName, initialJob.pane, initialJob.id) || initialJob;
    if (current.status !== DELIVERED_UNVERIFIED_STATE || current.unverifiedNoticeSentAt) {
      return current;
    }
    current = queue.update(current, {
      unverifiedNoticeAttempts: Number(current.unverifiedNoticeAttempts || 0) + 1,
      unverifiedNoticeNextAttemptAt: null,
    });
    if (!current.metadata?.channelId && typeof resolveNotificationChannel === "function") {
      let channelId = null;
      try {
        channelId = await resolveNotificationChannel(current);
      } catch (error) {
        log(`delivery broker notification channel lookup failed for ${current.id}: ${error.message}`);
      }
      if (!channelId) {
        const unavailable = queue.update(current, {
          unverifiedNoticeNextAttemptAt: now() + blockedRetryMs(current),
          unverifiedNoticeLastReason: "no Discord channel is currently bound to the target pane",
        });
        log(`delivery broker unverified notice pending for ${unavailable.id}: no bound Discord channel`);
        return unavailable;
      }
      current = queue.update(current, {
        metadata: { channelId: String(channelId) },
        unverifiedNoticeLastReason: null,
      });
    }
    try {
      await notify(current, "unverified");
      return queue.update(current, {
        unverifiedNoticeSentAt: now(),
        unverifiedNoticeNextAttemptAt: null,
        unverifiedNoticeLastReason: null,
      });
    } catch (error) {
      const failed = queue.update(current, {
        unverifiedNoticeNextAttemptAt: now() + blockedRetryMs(current),
        unverifiedNoticeLastReason: error.message,
      });
      log(`delivery broker unverified notice failed for ${failed.id}: ${error.message}`);
      return failed;
    }
  }

  async function terminalizeUnverified(job) {
    let current = queue.read(job.agentName, job.pane, job.id) || job;
    if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;

    // Recheck only the authoritative sink at the transition boundary. TUI
    // inspection is allowed to annotate a pending submit, never to postpone
    // or trigger this outcome.
    if (await exactEcho(current)) return acknowledge(current, "late-echo-before-unverified");
    current = queue.read(current.agentName, current.pane, current.id) || current;
    if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;
    if (await exactEcho(current)) return acknowledge(current, "late-echo-before-unverified");
    current = queue.read(current.agentName, current.pane, current.id) || current;
    if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;

    const terminal = queue.update(current, {
      status: DELIVERED_UNVERIFIED_STATE,
      draftOwned: false,
      terminalAt: now(),
      nextAttemptAt: null,
      unverifiedNoticeSentAt: null,
      unverifiedNoticeNextAttemptAt: now(),
      lastReason: "submit attempt has no exact JSONL receipt after 60 minutes; delivery remains unverified",
    });
    queueEvent(terminal, DELIVERED_UNVERIFIED_STATE);
    return notifyUnverified(terminal);
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

    // `pasting` means this broker persisted ownership before the Codex pane
    // write, but never proved the exact draft and therefore never attempted
    // Enter. An idle empty composer is conclusive: nothing was submitted, so
    // the immutable job may safely return to pending. Foreign/hidden content
    // stays fenced and is never cleared or submitted automatically.
    if (job.status === "pasting") {
      if (typeof agent.promptTransportState !== "function") {
        return queue.update(job, {
          nextAttemptAt: now() + MAX_BLOCKED_RETRY_MS,
          lastReason: "provisional paste cannot be inspected safely",
        });
      }
      const transport = await agent.promptTransportState(job.agentName, job.pane, job.text)
        .catch(() => ({ state: "hidden" }));
      if (transport.state === "empty-idle") {
        return queue.update(job, {
          status: "pending",
          draftOwned: false,
          nextAttemptAt: now(),
          lastReason: "provisional paste absent from idle composer; retrying exact payload",
        });
      }
      if (transport.state === "drafted") {
        job = queue.update(job, {
          status: "drafted",
          draftOwned: true,
          nextAttemptAt: now(),
          lastReason: null,
        });
      } else {
        job = queue.update(job, {
          status: "pasting",
          draftOwned: true,
          nextAttemptAt: now() + blockedRetryMs(job, { drafted: true }),
          lastReason: transport.state === "foreign"
            ? `provisional paste differs from composer; preserving both (${transport.detail || "unknown"})`
            : "provisional paste is not currently observable; refusing Enter or duplicate paste",
        });
        return maybeNotifyBlocked(job);
      }
    }

    // A submit key was attempted, but that is not delivery truth. Never type
    // again merely because JSONL is late, and never let TUI inspection reopen
    // or release the FIFO head. Only the exact JSONL event can acknowledge it.
    if (job.status === "submitted") {
      // Slash commands intentionally have no JSONL user event. The durable
      // submitted transition is their terminal proof after a crash between
      // composer verification and the final acknowledged file update.
      if (job.kind === "slash") return acknowledge(job, "slash-submit-recovery");
      const submittedAge = now() - Number(job.submittedAt || job.lastAttemptAt || job.createdAt || now());
      const submittedExpired = submittedAge >= STALE_SUBMITTED_TERMINAL_MS;
      if (submittedExpired) return terminalizeUnverified(job);
      let transportHint = null;
      if (submittedAge >= 5_000 && typeof agent.promptTransportState === "function") {
        const transport = await agent.promptTransportState(job.agentName, job.pane, job.text)
          .catch(() => null);
        if (transport?.state) {
          transportHint = `TUI hint: ${transport.state}${transport.detail ? ` (${transport.detail})` : ""}`;
        }
      }
      return queue.update(job, {
        status: "submitted",
        draftOwned: false,
        nextAttemptAt: now() + ACTIVE_RETRY_MS,
        lastReason: transportHint
          ? `awaiting exact JSONL receipt; ${transportHint}`
          : "awaiting exact JSONL receipt",
      });
    }

    let ownsPaneDraft = Boolean(job.draftOwned);
    let drafted = job.status === "drafted";
    let submitted = false;
    job = queue.update(job, {
      status: drafted ? "drafted" : (ownsPaneDraft ? "pasting" : "delivering"),
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
          knownDrafted: ownsPaneDraft,
          onPasteStarted: async () => {
            ownsPaneDraft = true;
            const current = queue.read(job.agentName, job.pane, job.id) || job;
            job = queue.update(current, { status: "pasting", draftOwned: true });
            queueEvent(job, "pasting");
          },
          suppressReceipt: true,
          onDrafted: async () => {
            ownsPaneDraft = true;
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
          transportHint: error.message,
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
        queueEvent(job, "zoom_fallback", {
          reason: String(result.reason || result.transportHint || "").slice(0, 160),
        });
        result = await attemptDelivery();
      } catch (error) {
        result = {
          delivered: false,
          transportHint: error.message,
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
    if (submitted) {
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

    const reason = result.reason || (result.transportHint
      ? `awaiting exact JSONL receipt; TUI hint: ${result.transportHint}`
      : "prompt has not reached authoritative JSONL yet");
    job = queue.update(job, {
      status: drafted ? "drafted" : (ownsPaneDraft ? "pasting" : "pending"),
      draftOwned: ownsPaneDraft,
      lastReason: reason,
      nextAttemptAt: now() + blockedRetryMs(job, { drafted: ownsPaneDraft }),
    });
    queueEvent(job, "pending", { reason: String(reason).slice(0, 160) });
    return job;
  }

  async function drainTarget(agentName, pane) {
    if (typeof validateTarget === "function") {
      try {
        await validateTarget(agentName, pane);
      } catch (error) {
        for (const job of queue.list(agentName, pane)) {
          if (TERMINAL_DELIVERY_STATES.has(job.status)) continue;
          const cancelled = queue.update(job, {
            status: "cancelled",
            draftOwned: false,
            nextAttemptAt: null,
            terminalAt: now(),
            lastReason: `invalid delivery target: ${error.message}`,
          });
          queueEvent(cancelled, "cancelled", { reason: "invalid-target" });
        }
        log(`delivery target ${agentName}:${pane} cancelled: ${error.message}`);
        return;
      }
    }
    const acquireLease = queue.acquireSessionLease || queue.acquireTargetLease;
    const lease = acquireLease?.(agentName, pane) || null;
    if (acquireLease && !lease) return;
    try {
      while (!stopped) {
        const notices = (queue.pendingUnverifiedNotices?.(agentName, pane) || [])
          .filter((job) => Number(job.unverifiedNoticeNextAttemptAt || 0) <= now());
        for (const notice of notices) await notifyUnverified(notice);

        // Every non-terminal head, including `submitted`, retains FIFO until
        // the exact JSONL event acknowledges it. A TUI transition can no
        // longer release later writes or create out-of-order receipts.
        const head = queue.next(agentName, pane);
        if (!head || Number(head.nextAttemptAt || 0) > now()) return;
        const outcome = await processJob(head);
        if (outcome.status === "acknowledged") {
          continue;
        }
        return;
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
    if (typeof validateTarget === "function") {
      validateTarget(request.agentName, request.pane);
    }
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
    const unverified = job.status === DELIVERED_UNVERIFIED_STATE;
    return {
      job,
      delivered: job.status === "acknowledged",
      pending: !TERMINAL_DELIVERY_STATES.has(job.status),
      cancelled: job.status === "cancelled",
      unverified,
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
