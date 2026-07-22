// Single-writer delivery broker.
// Producers persist jobs through delivery-queue.mjs.  This broker is the only
// normal tmux writer while the bridge is running. It serializes every source
// per pane, keeps an unacknowledged prompt at the head of the FIFO, and
// resumes it after a bridge restart. A durable submitted transition is an
// at-most-once fence, not delivery truth: only JSONL acknowledgement releases
// the next physical prompt write.

import { appendEvent } from "./events.mjs";
import { deliverToPane } from "./delivery.mjs";
import { rewriteModelSlash } from "./claude-model.mjs";
import { recoverSupersededSubmit } from "./submit-boundary.mjs";
import { createDeliveryNotSent, PRE_SUBMIT_STATES } from "./delivery-not-sent.mjs";
import { createDeliveryNotices } from "./delivery-notices.mjs";
import { createIngestProbeGate } from "./ingest-probe-gate.mjs";
import { createWakeAdmissionGate } from "./wake-admission.mjs";
import { wakeDeliveryTarget } from "./delivery-wake.mjs";
import {
  DELIVERED_UNVERIFIED_STATE, TERMINAL_DELIVERY_STATES,
  NOT_INGESTING_UNVERIFIED_STREAK, isTargetProvenNotIngesting, waitForDeliveryJob,
} from "./delivery-queue.mjs";
import { recoverHiddenDeliveryTui, recoverSubmittedTui } from "./tui-stall-recovery.mjs";
const ACTIVE_RETRY_MS = 1_000;
const BLOCKED_RETRY_MS = 3_000;
const MAX_BLOCKED_RETRY_MS = 60_000;
// Warn well before a legitimate long turn reaches the 60-minute verdict.
const SUBMITTED_STALL_NOTICE_MS = 3 * 60_000;
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

/** WHAT: Builds the single-writer delivery broker over the durable queue. WHY: Keeps every pane write serialized, receipt-gated, and restart-safe. */
export function createDeliveryBroker({
  agent,
  queue,
  notify = async () => {},
  resolveNotificationChannel = null,
  validateTarget = null,
  intervalMs = 500,
  now = () => Date.now(),
  log = (message) => console.warn(message),
  wakeAdmission = null,
  wakeLifecycle = null,
  bridgeDir = null,
} = {}) {
  if (!agent) throw new Error("delivery broker requires agent");
  if (!queue) throw new Error("delivery broker requires queue");

  // A durable message may wake exactly its target pane, but only after
  // admission proves release identity and memory headroom; otherwise the
  // message stays queued with a classified reason, never false-ACKed.
  const wakeGate = typeof wakeAdmission === "function" ? wakeAdmission
    : (bridgeDir ? createWakeAdmissionGate({ runtimeRoot: bridgeDir, reserveMiB: 512 }) : null);

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
    if (!job.echoCursor && !job.echoNotBeforeMs) return false;
    try {
      if (job.kind === "slash" && typeof agent.waitForSlashReceipt === "function") {
        return await agent.waitForSlashReceipt(
          job.agentName,
          job.pane,
          rewriteModelSlash(job.verifyText),
          0,
          job.echoCursor
            ? { cursor: job.echoCursor }
            : { notBeforeMs: job.echoNotBeforeMs },
        );
      }
      if (job.kind !== "prompt") return false;
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

  const { maybeNotifyBlocked, notifyTerminal } = createDeliveryNotices({
    queue, now, notify, log, blockedRetryMs, resolveNotificationChannel,
  });
  const { stalePreSubmit, terminalizeNotSent } = createDeliveryNotSent({
    queue, agent, now, notify, log, queueEvent, exactEcho, acknowledge, notifyTerminal,
  });
  const gateIngestProbe = createIngestProbeGate({
    agent, queue, queueEvent, now, blockedRetryMs,
  });

  async function terminalizeUnverified(job, {
    skipEcho = false,
    reason = null,
    ambiguity = null,
  } = {}) {
    let current = queue.read(job.agentName, job.pane, job.id) || job;
    if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;

    // Recheck only the authoritative sink at the transition boundary. TUI
    // inspection is allowed to annotate a pending submit, never to postpone
    // or trigger this outcome.
    if (!skipEcho && await exactEcho(current)) return acknowledge(current, "late-echo-before-unverified");
    current = queue.read(current.agentName, current.pane, current.id) || current;
    if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;
    if (!skipEcho && await exactEcho(current)) return acknowledge(current, "late-echo-before-unverified");
    current = queue.read(current.agentName, current.pane, current.id) || current;
    if (TERMINAL_DELIVERY_STATES.has(current.status)) return current;

    const preEnterFence = current.status === "submitting";
    const terminal = queue.update(current, {
      status: DELIVERED_UNVERIFIED_STATE,
      draftOwned: false,
      terminalAt: now(),
      nextAttemptAt: null,
      unverifiedNoticeSentAt: null,
      unverifiedNoticeNextAttemptAt: now(),
      ...(ambiguity || preEnterFence ? {
        metadata: { deliveryAmbiguity: ambiguity || "submitting-fence" },
      } : {}),
      lastReason: reason || (preEnterFence
        ? "pre-Enter submit fence has no exact receipt after 60 minutes; physical delivery remains unverified"
        : "submit attempt has no exact JSONL receipt after 60 minutes; delivery remains unverified"),
    });
    queueEvent(terminal, DELIVERED_UNVERIFIED_STATE);
    return notifyTerminal(terminal);
  }

  /**
   * A target proven not to ingest answers its whole backlog now rather than one
   * receipt budget at a time, which is what let a single wedged pane drain one
   * message per hour while producers enqueued six.
   *
   * The head is deliberately spared and keeps making its real attempt: it is
   * the recovery probe. Only an acknowledgement ends the streak, so a breaker
   * that also silenced the head could never observe one again and would mute a
   * healed pane forever.
   */
  async function answerBacklogBehindProbe(agentName, pane, head) {
    if (!isTargetProvenNotIngesting(queue.list(agentName, pane))) return;
    for (const job of queue.list(agentName, pane)) {
      if (job.id === head.id || TERMINAL_DELIVERY_STATES.has(job.status)) continue;
      await terminalizeNotSent(job);
    }
  }

  const cancellationRequested = (job) => job.cancelRequestStatus === "requested";

  async function processJob(initialJob) {
    let job = queue.read(initialJob.agentName, initialJob.pane, initialJob.id) || initialJob;
    queue.restoreAssets?.(job);

    // Native targets have an HTTP receipt as their authoritative sink. The
    // stable delivery job id becomes the runtime idempotency key, so a lost
    // HTTP response or bridge restart is retried without launching a second
    // turn. No tmux cursor, composer draft or JSONL echo participates here.
    // A legacy submit fence remains authoritative if routing flips while it
    // is unresolved. Sending it to a new native backend would create the
    // duplicate that the fence exists to prevent.
    if (job.status !== "submitting"
        && job.status !== "submitted"
        && typeof agent.isNativeTarget === "function"
        && agent.isNativeTarget(job.agentName, job.pane)) {
      job = queue.update(job, {
        status: "delivering",
        attempts: Number(job.attempts || 0) + 1,
        lastAttemptAt: now(),
        nextAttemptAt: null,
      });
      queueEvent(job, "native_attempt", { attempt: job.attempts });
      try {
        const result = await agent.deliverQueued(job);
        if (result?.accepted) {
          if (result.completionPending) {
            const submitted = queue.update(job, {
              status: "submitted",
              submittedAt: now(),
              nextAttemptAt: now() + ACTIVE_RETRY_MS,
              metadata: {
                deliveryTransport: "native",
                nativeOperationKey: result.operationKey || `delivery:${job.id}`,
              },
              lastReason: "native turn accepted; awaiting successful completion receipt",
            });
            queueEvent(submitted, "submitted", { via: "native" });
            return submitted;
          }
          return acknowledge(job, result.replayed ? "native-replay" : result.via || "native");
        }
        const reason = result?.reason || "native runtime did not accept delivery";
        const pending = queue.update(job, {
          status: "pending",
          lastReason: reason,
          nextAttemptAt: now() + blockedRetryMs(job),
        });
        queueEvent(pending, "native_pending", { reason: String(reason).slice(0, 160) });
        return maybeNotifyBlocked(pending);
      } catch (error) {
        const cancelled = queue.update(job, {
          status: "cancelled",
          draftOwned: false,
          nextAttemptAt: null,
          terminalAt: now(),
          lastReason: `native delivery rejected: ${error.message}`,
        });
        queueEvent(cancelled, "cancelled", { reason: "native-rejected" });
        log(`native delivery ${job.agentName}:${job.pane} ${job.id} rejected: ${error.message}`);
        return cancelled;
      }
    }

    // Persist a same-host timestamp before the first possible tmux write.
    // Event-identity cursors are stronger, but a fresh/missing JSONL can make
    // cursor capture return null; without this fallback a later real echo
    // would be invisible after restart and the broker could retype it.
    if (job.kind === "prompt"
        && job.metadata?.deliveryTransport !== "native"
        && !job.echoNotBeforeMs) {
      job = queue.update(job, { echoNotBeforeMs: now() });
    }

    if (!job.echoCursor
        && (job.kind === "prompt" || job.kind === "slash")
        && job.metadata?.deliveryTransport !== "native") {
      const captureCursor = job.kind === "slash"
        ? agent.captureSlashReceiptCursor
        : agent.capturePromptEchoCursor;
      const cursorText = job.kind === "slash" ? rewriteModelSlash(job.verifyText) : job.verifyText;
      let cursor = null;
      if (typeof captureCursor === "function") {
        try {
          cursor = await captureCursor.call(agent, job.agentName, job.pane, cursorText);
        } catch (error) {
          log(`delivery broker cursor failed for ${job.agentName}:${job.pane}: ${error.message}`);
        }
      }
      if (cursor) job = queue.update(job, { echoCursor: cursor });
    }

    // Every resume/retry starts at the authoritative sink. A crash after
    // Enter but before the job file update is therefore acknowledged without
    // retyping the prompt.
    if (await exactEcho(job)) return acknowledge(job, "echo");

    // Before Enter there is no delivery ambiguity: the broker has not sent
    // the instruction. Preserve any foreign/partial composer content, stop
    // retrying after a bounded safety budget, and release the FIFO with an
    // explicit durable NOT SENT notice. A job that merely waited behind an
    // older head has attempts=0 and always receives one real attempt first.
    if (stalePreSubmit(job)) return terminalizeNotSent(job);

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

    // A submit fence is ambiguous unless a later compact boundary proves that
    // Claude discarded that epoch without ingesting the exact prompt.
    if (job.status === "submitted" || job.status === "submitting") {
      if (job.status === "submitted" && job.metadata?.deliveryTransport === "native") {
        const submittedAge = now() - Number(
          job.submittedAt || job.lastAttemptAt || job.createdAt || now(),
        );
        let native = null;
        try {
          native = typeof agent.deliveryStatus === "function"
            ? await agent.deliveryStatus(job)
            : null;
        } catch (error) {
          return queue.update(job, {
            status: "submitted",
            draftOwned: false,
            nextAttemptAt: now() + ACTIVE_RETRY_MS,
            lastReason: `native completion check unavailable: ${error.message}`,
          });
        }
        if (native?.state === "completed") return acknowledge(job, "native-turn-complete");
        if (native?.state === "interrupted") return acknowledge(job, "native-turn-interrupted");
        if (native?.state === "failed") {
          return terminalizeUnverified(job, {
            skipEcho: true,
            ambiguity: "native-turn-failed",
            reason: `native runtime accepted the turn but it failed before a successful completion receipt: ${native.reason}`,
          });
        }
        if (submittedAge >= STALE_SUBMITTED_TERMINAL_MS) {
          return terminalizeUnverified(job, {
            skipEcho: true,
            ambiguity: "native-completion-missing",
            reason: "native runtime accepted the turn but no terminal operation receipt appeared within 60 minutes; delivery remains unverified",
          });
        }
        return queue.update(job, {
          status: "submitted",
          draftOwned: false,
          nextAttemptAt: now() + ACTIVE_RETRY_MS,
          lastReason: native?.state === "running"
            ? "native turn accepted; awaiting successful completion receipt"
            : "native turn receipt is not yet readable; awaiting completion without redispatch",
        });
      }
      // Older Claude/Codex jobs had no command-event cursor, so preserve their
      // at-most-once recovery contract. New Claude jobs remain fenced until
      // the exact <command-name> + <command-args> JSONL receipt is visible.
      if (job.kind === "slash" && job.status === "submitted") {
        if (!job.echoCursor || typeof agent.waitForSlashReceipt !== "function") {
          return acknowledge(job, "slash-submit-recovery");
        }
      }
      const superseded = await recoverSupersededSubmit({ job, agent, queue, exactEcho,
        acknowledge, now, onRecovered: (value, state) => queueEvent(value, state) });
      if (superseded) return superseded;
      const recoveredTui = await recoverSubmittedTui({ job, agent, queue, exactEcho, acknowledge, now, log,
        onRecovered: (value) => queueEvent(value, "submit_recovered_after_stall") });
      if (recoveredTui) return recoveredTui;
      const submittedAge = now() - Number(
        job.submittedAt || job.submitFenceAt || job.lastAttemptAt || job.createdAt || now(),
      );
      const submittedExpired = submittedAge >= STALE_SUBMITTED_TERMINAL_MS;
      if (submittedExpired) return terminalizeUnverified(job);
      // One durable notice reports a stalled FIFO and closes with recovered on receipt.
      if (!job.noticeSentAt && submittedAge >= SUBMITTED_STALL_NOTICE_MS) {
        const queuedBehind = queue.list(job.agentName, job.pane)
          .filter((other) => other.id !== job.id && !TERMINAL_DELIVERY_STATES.has(other.status))
          .length;
        job = queue.update(job, { noticeSentAt: now() });
        await notify(job, "stalled", { queuedBehind }).catch((error) =>
          log(`delivery broker stalled notice failed for ${job.id}: ${error.message}`));
      }
      let transportHint = null;
      if (submittedAge >= 5_000 && typeof agent.promptTransportState === "function") {
        const transport = await agent.promptTransportState(job.agentName, job.pane, job.text)
          .catch(() => null);
        if (transport?.state) {
          transportHint = `TUI hint: ${transport.state}${transport.detail ? ` (${transport.detail})` : ""}`;
        }
      }
      const receiptWait = job.status === "submitted"
        ? (job.kind === "slash" ? "awaiting exact command receipt" : "awaiting exact JSONL receipt")
        : "submit fence committed before physical completion; awaiting authoritative receipt";
      return queue.update(job, {
        status: job.status,
        draftOwned: false,
        nextAttemptAt: now() + ACTIVE_RETRY_MS,
        lastReason: transportHint
          ? `${receiptWait}; ${transportHint}`
          : receiptWait,
      });
    }

    let ownsPaneDraft = Boolean(job.draftOwned);
    let drafted = job.status === "drafted";
    let submitted = false;
    job = queue.update(job, {
      status: drafted ? "drafted" : (ownsPaneDraft ? "pasting" : "delivering"),
      attempts: Number(job.attempts || 0) + 1,
      firstAttemptAt: job.firstAttemptAt || now(),
      lastAttemptAt: now(),
      nextAttemptAt: null,
    });
    queueEvent(job, "attempt", { attempt: job.attempts });

    const wake = await wakeDeliveryTarget({ agent, job, wakeGate, wakeLifecycle,
      drafted, ownsPaneDraft, queue, now, retryMs: blockedRetryMs,
      queueEvent, notifyBlocked: maybeNotifyBlocked });
    job = wake.job;
    if (!wake.proceed) return job;

    // A receiptless retry re-proves pane liveness before the payload is
    // committed again; a silent pane keeps the FIFO parked, never retyped.
    const gated = await gateIngestProbe(job, { drafted, ownsPaneDraft });
    job = gated.job;
    if (!gated.proceed) return maybeNotifyBlocked(job);

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
          onSubmitting: async () => {
            const current = queue.read(job.agentName, job.pane, job.id) || job;
            if (cancellationRequested(current)) {
              const error = new Error("delivery cancellation requested before submit fence");
              error.code = "AMUX_DELIVERY_CANCEL_REQUESTED";
              throw error;
            }
            job = queue.update(current, {
              status: "submitting",
              draftOwned: false,
              submitFenceAt: now(),
              nextAttemptAt: now() + ACTIVE_RETRY_MS,
            });
            queueEvent(job, "submitting");
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
    if (cancellationRequested(job) && PRE_SUBMIT_STATES.has(job.status)) {
      return terminalizeNotSent(job);
    }
    if (job.status === "submitting") {
      return queue.update(job, {
        draftOwned: false,
        nextAttemptAt: now() + ACTIVE_RETRY_MS,
        lastReason: "submit fence committed before physical completion; awaiting authoritative receipt",
      });
    }
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

    return recoverHiddenDeliveryTui({ job, reason, agent, queue, now, queueEvent, log });
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
        // Cancellation is a request, never a producer-side state rewrite.
        // Resolve every request while holding the same writer lease as pane
        // delivery; this safely removes an attempts=0 follower out of order.
        const cancellationRequests = queue.pendingCancellationRequests?.(agentName, pane) || [];
        for (const request of cancellationRequests) await terminalizeNotSent(request);

        const notices = (queue.pendingTerminalNotices?.(agentName, pane)
          || queue.pendingUnverifiedNotices?.(agentName, pane) || [])
          .filter((job) => Number(job.unverifiedNoticeNextAttemptAt || 0) <= now());
        for (const notice of notices) await notifyTerminal(notice);

        // Every non-terminal head, including `submitted`, retains FIFO until
        // the exact JSONL event acknowledges it. A TUI transition can no
        // longer release later writes or create out-of-order receipts.
        const head = queue.next(agentName, pane);
        if (!head) return;
        await answerBacklogBehindProbe(agentName, pane, head);
        if (Number(head.nextAttemptAt || 0) > now()) return;
        const outcome = await processJob(head);
        if (TERMINAL_DELIVERY_STATES.has(outcome.status)) continue;
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
