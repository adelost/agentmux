// Durable Discord inbound reconciliation. Gateway events are the fast path;
// the private intake journal and REST history repair own restart safety.

import { transcriptPayload } from "./discord-transcript-effect.mjs";

const TYPING_INTERVAL_MS = 8_000;

/** WHAT: Formats one batch-level recovery notice. WHY: Keeps rare delivery repair visible without per-message spam. */
export function formatRecoveredNotice(count) {
  const n = Math.max(0, Number(count) || 0);
  return `ℹ Recovered ${n} message${n === 1 ? "" : "s"} missed during reconnect.`;
}

function transcriptSender(record, store, channel, baseMessage) {
  return async (chunks) => {
    const prior = store.read(record.channelId, record.messageId)?.effects?.["transcript-reply"] || null;
    if (!store.beginEffect(record, "transcript-reply")) return false;
    for (let index = 0; index < chunks.length; index++) {
      const payload = transcriptPayload(record.identity, index, chunks[index]);
      if (prior?.status === "sending" && typeof channel.findMessageByNonce === "function"
          && await channel.findMessageByNonce(record.channelId, payload.nonce, record.messageId)) {
        continue;
      }
      if (index === 0 && typeof baseMessage?.reply === "function") {
        await baseMessage.reply(payload);
      } else if (index === 0 && typeof channel.replyTo === "function") {
        await channel.replyTo(record.channelId, record.messageId, payload);
      } else {
        await channel.send(record.channelId, payload);
      }
    }
    store.completeEffect(record, "transcript-reply");
    return true;
  };
}

/** WHAT: Rehydrates one journal record as a channel message. WHY: Attachment and handler retries must keep the original Discord identity and one-shot transcript effect. */
function durableMessage(record, store, channel, baseMessage = null) {
  const send = (content) => channel.send(record.channelId, content);
  const reply = typeof baseMessage?.reply === "function"
    ? (content) => baseMessage.reply(content)
    : typeof channel.replyTo === "function"
      ? (content) => channel.replyTo(record.channelId, record.messageId, content)
      : send;
  return {
    channelId: record.channelId,
    text: record.text,
    authorId: record.authorId,
    isBot: false,
    id: record.messageId,
    createdTimestamp: record.createdTimestamp,
    resolvedTarget: record.target,
    attachments: (record.attachments || []).map((attachment) => ({ ...attachment })),
    getCachedTranscript: (attachmentId) => store.transcriptFor(record, attachmentId),
    saveTranscript: (attachmentId, transcript) =>
      store.saveTranscript(record, attachmentId, transcript),
    reply,
    send,
    sendTranscriptOnce: transcriptSender(record, store, channel, baseMessage),
    startTyping() {
      if (typeof baseMessage?.startTyping === "function") return baseMessage.startTyping();
      if (typeof channel.sendTyping !== "function") return () => {};
      channel.sendTyping(record.channelId).catch(() => {});
      const timer = setInterval(() => channel.sendTyping(record.channelId).catch(() => {}),
        TYPING_INTERVAL_MS);
      return () => clearInterval(timer);
    },
  };
}

/**
 * WHAT: Builds one journaled dispatcher for live or REST-recovered Discord messages.
 * WHY: Keeps attachment, STT, and pane work behind a durable human-message identity.
 */
export function createInboundReconciler({ onMessage, state, store, resolveTarget }) {
  if (!store) throw new Error("Discord inbound reconciler requires a durable store");
  if (typeof resolveTarget !== "function") {
    throw new Error("Discord inbound reconciler requires a target resolver");
  }
  const queues = new Map();
  const scans = new Map();
  const preparations = new Map();

  function prepare(record) {
    const existing = preparations.get(record.identity);
    if (existing) return existing;
    let tracked;
    tracked = Promise.resolve().then(() => store.prepareAttachments(record)).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    ).finally(() => {
      if (preparations.get(record.identity) === tracked) preparations.delete(record.identity);
    });
    preparations.set(record.identity, tracked);
    return tracked;
  }

  async function preparedRecord(preparation) {
    const result = await preparation;
    if (!result.ok) throw result.error;
    return result.value;
  }

  function observe(msg) {
    if (!msg || msg.isBot) return null;
    const target = resolveTarget(msg);
    if (!target) return null;
    return store.observe(msg, target);
  }

  async function processRecord(record, channel, baseMessage, prepared = null) {
    let current = store.read(record.channelId, record.messageId) || record;
    if (current.status === "completed") return { duplicate: true };
    try {
      current = await preparedRecord(prepared || prepare(current));
      const outcome = await onMessage(durableMessage(current, store, channel, baseMessage));
      if (outcome?.delivered === false) {
        store.fail(current, outcome.reason || "handler did not durably accept the message");
        return { delivered: false, retryable: true };
      }
      store.complete(current, outcome || null);
      return { delivered: true };
    } catch (error) {
      store.fail(current, error);
      throw error;
    }
  }

  function schedule(record, channel, baseMessage = null, prepared = null) {
    const channelId = record.channelId;
    const previous = queues.get(channelId) || Promise.resolve();
    const next = previous.catch(() => {}).then(() =>
      processRecord(record, channel, baseMessage, prepared));
    let tracked;
    tracked = next.finally(() => {
      if (queues.get(channelId) === tracked) queues.delete(channelId);
    });
    queues.set(channelId, tracked);
    return tracked;
  }

  /** WHAT: Accepts one Gateway event through a synchronous durable observation. WHY: Expensive attachment and STT work may never precede crash-safe identity. */
  function enqueue(msg, channel) {
    const record = observe(msg);
    if (!record) return Promise.resolve({ ignored: msg?.isBot ? "bot" : "unmapped" });
    if (record.status === "completed") return Promise.resolve({ duplicate: true });
    const prepared = prepare(record);
    return schedule(record, channel, msg, prepared);
  }

  async function messageForPending(channel, record, fetchedById) {
    if (fetchedById.has(record.messageId)) return fetchedById.get(record.messageId);
    if (typeof channel.fetchMessage !== "function") return null;
    try {
      const msg = await channel.fetchMessage(record.channelId, record.messageId);
      if (msg) observe(msg);
      return msg;
    } catch {
      return null;
    }
  }

  async function drainPending(channel, channelId, fetchedById = new Map(), newlyObserved = null) {
    let replayed = 0;
    const pending = store.pending(channelId);
    for (const record of pending) {
      const baseMessage = await messageForPending(channel, record, fetchedById);
      const refreshed = store.read(record.channelId, record.messageId) || record;
      const result = await schedule(refreshed, channel, baseMessage, prepare(refreshed));
      if (result?.delivered && (!newlyObserved || newlyObserved.has(record.messageId))) replayed++;
    }
    return { replayed, pending: store.pending(channelId).length };
  }

  /** WHAT: Drains a journaled channel without fetching new input. WHY: Keeps persisted targets deliverable after their live channel mapping is removed. */
  function drain(channel, channelId) {
    return drainPending(channel, channelId);
  }

  /** WHAT: Repairs one channel from its durable cursor and pending journal. WHY: Reconnects must recover text, files, images, and audio without Gateway replay. */
  function reconcile(channel, channelId) {
    const previous = scans.get(channelId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      if (typeof channel.fetchMissed !== "function") return { skipped: true };
      let afterId = store.cursor(channelId);
      const legacyCursor = state?.get?.(`last_inbound_${channelId}`, null) || null;
      if (!afterId && legacyCursor) afterId = store.advanceCursor(channelId, legacyCursor);
      const initialSeed = !afterId;
      const seedOptions = initialSeed ? { limit: 1, maxAgeMs: 0 } : undefined;
      const { messages = [], newestId = null } = await channel.fetchMissed(channelId, afterId, seedOptions);
      const fetchedById = new Map();
      const newlyObserved = new Set();
      const staged = [];

      // Keep the established first-install contract: a newly configured
      // channel starts at "now" instead of replaying unrelated history.
      // Pending journal records still drain below, covering a crash between
      // first Gateway observation and the first cursor write.
      if (initialSeed) {
        for (const msg of messages) fetchedById.set(String(msg.id), msg);
        if (newestId) store.advanceCursor(channelId, newestId);
      }

      // Observe the complete REST batch synchronously before the cursor moves.
      // Attachment copies start immediately and may run concurrently, while
      // handler execution below remains in source order.
      for (const msg of initialSeed ? [] : messages) {
        const before = store.read(msg.channelId, msg.id);
        const record = observe(msg);
        if (!record) throw new Error(`Discord target disappeared for ${msg.channelId}:${msg.id}`);
        fetchedById.set(record.messageId, msg);
        if (!before) newlyObserved.add(record.messageId);
        staged.push(prepare(record));
      }
      // A cursor may pass an attachment only after its bytes are private and
      // durable. If the bridge dies here, the old cursor intentionally causes
      // a harmless re-fetch instead of relying on an expiring signed URL.
      await Promise.all(staged.map(preparedRecord));
      if (!initialSeed && newestId && newestId !== afterId) store.advanceCursor(channelId, newestId);

      return drainPending(channel, channelId, fetchedById, newlyObserved);
    });
    let tracked;
    tracked = next.finally(() => {
      if (scans.get(channelId) === tracked) scans.delete(channelId);
    });
    scans.set(channelId, tracked);
    return tracked;
  }

  return { enqueue, reconcile, drain };
}
