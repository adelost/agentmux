// Durable Discord inbound reconciliation. Gateway events are the fast path;
// periodic channel scans repair gaps caused by reconnects or bridge restarts.

const DEFAULT_SEEN_LIMIT = 100;

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

/**
 * A live event never advances the scan cursor. Only a completed REST scan may
 * do that, after every human message in the scanned range has been handled.
 * This is what makes a missed human message recoverable even when later bot
 * output has already appeared in the channel.
 *
 * WHAT: Dispatches live Discord messages and missed REST messages in channel order.
 * WHY: Prevents restart gaps and duplicate paths from losing or repeating human prompts.
 */
export function createInboundReconciler({ onMessage, state, seenLimit = DEFAULT_SEEN_LIMIT }) {
  const queues = new Map();
  const scans = new Map();

  function enqueue(msg) {
    if (!msg || msg.isBot) return Promise.resolve({ ignored: "bot" });
    const channelId = msg.channelId;
    if (!channelId) return Promise.resolve(onMessage(msg)).then(() => ({ delivered: true }));

    const previous = queues.get(channelId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (hasSeen(state, channelId, msg.id)) return { duplicate: true };
      await onMessage(msg);
      markSeen(state, channelId, msg.id, seenLimit);
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
