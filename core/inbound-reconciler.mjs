// Durable Discord inbound reconciliation. Gateway events are the fast path;
// periodic channel scans repair gaps caused by reconnects or bridge restarts.

const DEFAULT_SEEN_LIMIT = 100;
// A message the pane rejects DETERMINISTICALLY (blocked composer, oversized
// paste that never finishes painting) fails identically on every scan. Leaving
// it unseen makes the periodic REST scan re-deliver it forever, hammering the
// channel with the same warning. Cap total delivery attempts, then give up:
// mark it seen and stop. Mattias 2026-07-12: "gör 1 max 2 försök, den ska inte
// fortsätta." Transient failures (reconnect, a briefly busy pane) still get
// their retry within the cap.
const DEFAULT_MAX_DELIVERY_ATTEMPTS = 2;

/** WHAT: Formats one batch-level recovery notice. WHY: Keeps rare delivery repair visible without per-message spam. */
export function formatRecoveredNotice(count) {
  const n = Math.max(0, Number(count) || 0);
  return `ℹ Recovered ${n} message${n === 1 ? "" : "s"} missed during reconnect.`;
}

/** WHAT: Loads the per-channel delivered-message index. WHY: Keeps replay dedupe on one persisted schema. */
function seenState(state) {
  return state.get("inbound_seen_ids", {}) || {};
}

/** WHAT: Compares a Discord message against completed deliveries. WHY: Keeps Gateway and REST paths idempotent. */
function hasSeen(state, channelId, messageId) {
  if (!messageId) return false;
  const all = seenState(state);
  return (all[channelId] || []).includes(messageId);
}

/** WHAT: Stores a bounded delivered-message history. WHY: Keeps dedupe durable without unbounded state growth. */
function markSeen(state, channelId, messageId, limit) {
  if (!messageId) return;
  const all = seenState(state);
  const ids = (all[channelId] || []).filter((id) => id !== messageId);
  ids.push(messageId);
  all[channelId] = ids.slice(-limit);
  state.set("inbound_seen_ids", all);
}

/** Per-message delivery-attempt counter, so a deterministic failure gives up
 * instead of re-delivering forever. Cleared on success or give-up. */
function bumpAttempt(state, channelId, messageId) {
  const all = state.get("inbound_delivery_attempts", {}) || {};
  const byChannel = all[channelId] || {};
  const count = (byChannel[messageId] || 0) + 1;
  byChannel[messageId] = count;
  all[channelId] = byChannel;
  state.set("inbound_delivery_attempts", all);
  return count;
}

function clearAttempt(state, channelId, messageId) {
  const all = state.get("inbound_delivery_attempts", {}) || {};
  const byChannel = all[channelId];
  if (!byChannel || !(messageId in byChannel)) return;
  delete byChannel[messageId];
  if (Object.keys(byChannel).length === 0) delete all[channelId];
  state.set("inbound_delivery_attempts", all);
}

/**
 * A live event never advances the scan cursor. Only a completed REST scan may
 * do that, after every human message in the scanned range has been handled.
 * This is what makes a missed human message recoverable even when later bot
 * output has already appeared in the channel.
 *
 * WHAT: Dispatches live Discord messages and missed REST messages in channel order.
 * WHY: Prevents restart gaps and duplicate paths from losing or repeating human prompts.
 */
export function createInboundReconciler({ onMessage, state, seenLimit = DEFAULT_SEEN_LIMIT, maxDeliveryAttempts = DEFAULT_MAX_DELIVERY_ATTEMPTS }) {
  const queues = new Map();
  const scans = new Map();

  function enqueue(msg) {
    if (!msg || msg.isBot) return Promise.resolve({ ignored: "bot" });
    const channelId = msg.channelId;
    if (!channelId) return Promise.resolve(onMessage(msg)).then((outcome) =>
      outcome?.delivered === false
        ? { delivered: false, retryable: true }
        : { delivered: true });

    const previous = queues.get(channelId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (hasSeen(state, channelId, msg.id)) return { duplicate: true };
      const outcome = await onMessage(msg);
      // Handler-level transport failures are explicit outcomes, not handled
      // messages. Keeping the Discord id unseen lets the periodic REST scan
      // retry it; v1.21.2 warned the user but still marked these as delivered,
      // permanently dropping them from reconciliation.
      if (outcome?.delivered === false) {
        const attempts = bumpAttempt(state, channelId, msg.id);
        // A deterministic failure fails identically every scan. After the cap,
        // give up: mark it seen so it is never re-delivered, and stop the
        // warning hammer. The scan treats gaveUp as non-retryable and advances.
        if (attempts >= maxDeliveryAttempts) {
          markSeen(state, channelId, msg.id, seenLimit);
          clearAttempt(state, channelId, msg.id);
          return { delivered: false, gaveUp: true, attempts };
        }
        return { delivered: false, retryable: true, attempts };
      }
      markSeen(state, channelId, msg.id, seenLimit);
      clearAttempt(state, channelId, msg.id);
      return { delivered: true };
    });
    const tracked = next.finally(() => {
      if (queues.get(channelId) === tracked) queues.delete(channelId);
    });
    queues.set(channelId, tracked);
    return tracked;
  }

  function reconcile(channel, channelId) {
    const previous = scans.get(channelId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (typeof channel.fetchMissed !== "function") return { skipped: true };
      const cursorKey = `last_inbound_${channelId}`;
      const afterId = state.get(cursorKey, null);
      const { messages = [], newestId = null } = await channel.fetchMissed(channelId, afterId);

      // First boot establishes a stream checkpoint without replaying history.
      if (!afterId) {
        if (newestId) state.set(cursorKey, newestId);
        return { seeded: Boolean(newestId), replayed: 0 };
      }

      let replayed = 0;
      for (const msg of messages) {
        const result = await enqueue(msg);
        if (result?.delivered) replayed++;
        if (result?.retryable) {
          // Preserve the scan cursor at the failed message. Earlier successes
          // are already in the seen-id set, so the next pass is idempotent and
          // retains channel order without losing later human messages.
          return { replayed, blocked: true };
        }
      }
      // newestId may be a bot message. Advancing to it is safe here because
      // this scan inspected the complete preceding range first.
      if (newestId && newestId !== afterId) state.set(cursorKey, newestId);
      return { replayed };
    });
    const tracked = next.finally(() => {
      if (scans.get(channelId) === tracked) scans.delete(channelId);
    });
    scans.set(channelId, tracked);
    return tracked;
  }

  return { enqueue, reconcile };
}
