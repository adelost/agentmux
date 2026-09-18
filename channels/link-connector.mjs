// WSL Link connector: outbound poller that carries mailbox messages to
// panes through the durable amux queue and posts replies back. It journals
// locally before every ack so a restart can never double-ack or double-reply.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { normalizeServiceBaseUrl } from "../core/runtime-defaults.mjs";

const JOURNAL_VERSION = 1;
/** Re-announce an unchanged list this often, well inside the worker's 24 h
 *  announce window, so a worker-side reset can never strand the phone's list. */
const ANNOUNCE_REFRESH_MS = 60 * 60_000;

/** WHAT: Normalises what the connector was given into announceable rows. WHY: The
 *  caller may pass ids, rows, or a function read fresh each cycle. */
export function announcedTargetList(targets) {
  const rows = (typeof targets === "function" ? targets() : targets) || [];
  return rows.map((target) => (typeof target === "string"
    ? { id: target, label: target }
    : { id: String(target.id), label: String(target.label ?? target.id) }));
}

/** WHAT: A stable fingerprint of one announced list. WHY: Announcing only on
 *  change needs a cheap comparison that notices a relabel as well as a new pane. */
export function listFingerprint(targets) {
  // JSON, not a separator byte: a literal NUL in the source turns this file
  // binary to git, which costs every future diff and blame on it.
  const text = JSON.stringify(targets.map((target) => [target.id, target.label]));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${targets.length}:${hash.toString(16)}`;
}

function readJournal(statePath) {
  try { return JSON.parse(readFileSync(statePath, "utf8")); }
  catch { return { version: JOURNAL_VERSION, messages: {} }; }
}

function writeJournal(statePath, journal) {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = join(`${statePath}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
  renameSync(tmp, statePath);
}

/**
 * WHAT: Reads the journal, applies one change and writes it back.
 * WHY: A reply wait now outlives the cycle that started it (row 186), so two
 *      writers hold their own copy. Merging into a fresh read keeps a slow
 *      task from restoring the state of a journal three cycles old.
 */
function updateJournal(statePath, id, patch) {
  const journal = readJournal(statePath);
  journal.messages = journal.messages || {};
  journal.messages[id] = { ...journal.messages[id], ...patch };
  writeJournal(statePath, journal);
  return journal.messages[id];
}

/** The reply waits this process is running, keyed by clientMessageId. One per
 *  message: the worker re-claims a delivered message every lease, and a second
 *  wait would post a second reply for the same turn. */
const runningReplyWaits = new Map();

/** WHAT: The clientMessageIds this process is still waiting on. WHY: Lets the
 *  bridge and its tests see the pending set without reaching into the map. */
export function pendingReplyWaits(waits = runningReplyWaits) {
  return [...waits.keys()];
}

/**
 * WHAT: Waits for one pane's reply and reports it, as its own task.
 * WHY: Row 186. While this waits, the cycle polls, beats and delivers to every
 *      other pane; one silent pane used to hold the whole connector for the
 *      full reply timeout. The give-up bound is unchanged, and so is what the
 *      mailbox sees: a timeout reports nothing and the worker's own
 *      REPLY_TIMEOUT_SECONDS returns the message to queued.
 */
async function awaitOneReply({
  id, target, prompt, agent, post, connectorId, statePath, replyTimeoutMs, sleep, attempts, log, waits,
}) {
  try {
    const replyText = await waitForLinkReply({ agent, target, prompt, replyTimeoutMs, sleep });
    // Journalled with its body BEFORE the post, for the same reason the delivery
    // is journalled before the ack: a pane answers once, and a lost post must
    // leave the answer somewhere the next claim can re-post it from (row 187).
    updateJournal(statePath, id, { stage: "replied", reply: replyText, replyAt: Date.now() });
    await post("/api/link/connector/reply", { clientMessageId: id, connectorId, body: replyText });
    return true;
  } catch (error) {
    const { stage, terminal } = connectorFailureDisposition(error, attempts);
    log(`link-connector ${id} failed:${stage} ${String(error?.message || error)}`);
    if (terminal) {
      await post("/api/link/connector/fail", { clientMessageId: id, connectorId, error: stage }).catch(() => {});
      updateJournal(statePath, id, { stage: "failed", error: stage });
    }
    return false;
  } finally {
    waits.delete(id);
  }
}

/** WHAT: Builds the pane prompt for one mailbox message. WHY: Keeps the reply correlation anchored to one exact marker. */
export function linkTurnPrompt({ clientMessageId, body }) {
  return `[amux-link-turn:${clientMessageId}]\n${String(body || "").trim()}`;
}

/**
 * WHAT: Maps one claimed message against the journal to its next step.
 * WHY: The journal is what this connector remembers; the mailbox row is what the
 * phone reads. When they disagree the mailbox is the one that is wrong for the
 * user, so the claim repairs it instead of trusting the journal and moving on.
 * Row 187, measured on production: a turn journalled delivered whose ack never
 * reached the mailbox was re-claimed 377 times, and the pane's real answer was
 * refused by the worker because an unacked row takes no reply.
 */
export function planClaimedMessage({ message, journalEntry }) {
  const mailboxAcked = Boolean(message?.deliveredAt);
  const mailboxReplied = message?.state === "replied" || Boolean(message?.replyAt);
  if (journalEntry?.stage === "failed") return { action: "skip", reason: "already-failed-locally" };
  if (journalEntry?.stage === "replied") {
    if (mailboxReplied) return { action: "skip", reason: "already-replied-locally" };
    // The answer exists here and nowhere else. Journal entries written before
    // the reply body was kept have nothing to re-post, so they wait for the
    // pane again rather than claiming an answer this connector cannot produce.
    const reply = typeof journalEntry.reply === "string" ? journalEntry.reply.trim() : "";
    if (reply) return { action: "repost-reply", message, reply, needsAck: !mailboxAcked };
    return { action: "await-reply", message, needsAck: !mailboxAcked };
  }
  if (journalEntry?.stage === "delivered") {
    return { action: "await-reply", message, needsAck: !mailboxAcked };
  }
  return { action: "deliver", message };
}

/** WHAT: Maps a fetch or pane failure to an honest connector report. WHY: Keeps a dead mailbox or pane from masquerading as a delivered turn. */
export function connectorFailureStage(error) {
  const text = String(error?.message || error || "unknown");
  if (/transcri(?:be|ption)/iu.test(text)) return "transcription-failed";
  if (/fetch|network|ECONN|timeout|5\d\d/u.test(text)) return "link-unavailable";
  return "pane-delivery-failed";
}

/** WHAT: Decides whether one failure is terminal or retryable. WHY: Invalid audio stops once while transient infrastructure gets a strict retry bound. */
export function connectorFailureDisposition(error, attempts = 1) {
  const stage = connectorFailureStage(error);
  const status = Number(error?.status || 0);
  const invalidAudio = stage === "transcription-failed" &&
    (status >= 400 && status < 500 ||
      /empty|invalid|unsupported|no bytes/iu.test(String(error?.message || error)));
  return {
    stage,
    terminal: stage === "pane-delivery-failed" ||
      invalidAudio ||
      (stage === "transcription-failed" && attempts >= 3),
  };
}

/**
 * WHAT: Puts one claimed turn on its pane and acks it, or leaves it recoverable.
 * WHY: Split out of runLinkConnectorCycle, whose fix history is this block's own
 * state: the idempotency key that stopped double delivery, the receipt that
 * stopped a false ack, the transcription that must fail before either. The
 * cycle above now reads as claim, advance, hand off.
 *
 * Returns true only when the pane holds the turn AND the mailbox knows: false
 * means nothing is lost, the lease simply expires and the turn comes back.
 */
async function deliverOneTurn({
  message, id, journal, statePath, fetchImpl, serviceBase, auth, transcribe,
  deliveryBroker, deliveryQueue, receiptTimeoutMs, sleep, post, connectorId, log,
}) {
  let body = String(message.body || "").trim();
  if (message.kind === "voice" && message.voiceRef) {
    const audio = await fetchImpl(`${serviceBase}/api/link/voice/${message.voiceRef}`, {
      headers: auth,
      signal: AbortSignal.timeout(60_000),
    });
    if (!audio.ok) throw new Error(`link-voice-${audio.status}`);
    if (typeof transcribe !== "function") throw new Error("transcribe-unavailable");
    body = String(await transcribe(Buffer.from(await audio.arrayBuffer()), message.voiceRef) || "").trim();
    if (!body) throw new Error("transcribe-empty");
  }
  const agentName = String(message.target).split(":")[0];
  const pane = Number(String(message.target).split(":")[1]);
  const prompt = linkTurnPrompt({ clientMessageId: id, body });
  const leaseAttempt = Number.isSafeInteger(message.attempts) && message.attempts > 0
    ? message.attempts : 1;
  journal.messages[id] = updateJournal(statePath, id, {
    stage: "claimed", at: Date.now(), target: message.target, prompt,
  });
  // The stable key is the dedup: the durable queue atomically returns the
  // existing job for a reused key. Only a proven cancelled job earns a rotated
  // key; a live or unproven job keeps its single pane write and can never
  // duplicate on reclaim.
  const stableKey = `link:${id}`;
  let job;
  try {
    job = deliveryBroker.enqueue({ agentName, pane, text: prompt, idempotencyKey: stableKey });
    if (job?.status === "cancelled") {
      job = deliveryBroker.enqueue({
        agentName,
        pane,
        text: prompt,
        idempotencyKey: `${stableKey}:attempt:${leaseAttempt}`,
      });
    }
  } catch (error) {
    log(`link-connector ${id} not-delivered:enqueue-refused ${String(error?.message || error)}`);
    return false;
  }
  journal.messages[id] = updateJournal(statePath, id, { stage: "enqueued", jobId: job?.id || null });
  // A merely enqueued job is not delivered: ack only on the broker's
  // acknowledged ingest receipt. Cancelled or timed out stays leased, so the
  // reclaim path keeps it recoverable without a false ack.
  const receipt = await waitForBrokerReceipt({
    queue: deliveryQueue,
    agentName,
    pane,
    jobId: job?.id,
    timeoutMs: receiptTimeoutMs,
    sleep,
  });
  if (!receipt.delivered) {
    log(`link-connector ${id} not-delivered:${receipt.terminal || "receipt-timeout"} (kept recoverable)`);
    return false;
  }
  await post("/api/link/connector/ack", { clientMessageId: id, connectorId });
  journal.messages[id] = updateJournal(statePath, id, { stage: "delivered" });
  return true;
}

/** WHAT: Dispatches one bounded poll cycle for the WSL connector. WHY: Keeps every message exactly once through claim, ack, and reply. */
export async function runLinkConnectorCycle({
  fetchImpl = fetch,
  linkBase,
  token,
  targets,
  connectorId = "wsl-1",
  agent,
  deliveryBroker,
  deliveryQueue = null,
  statePath,
  replyTimeoutMs = 20 * 60_000,
  receiptTimeoutMs = 120_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  transcribe = null,
  log = () => {},
  replyWaits = runningReplyWaits,
} = {}) {
  const serviceBase = normalizeServiceBaseUrl(linkBase, "Link base URL", { allowHttpLoopback: true });
  const journal = readJournal(statePath);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) => {
    const response = await fetchImpl(`${serviceBase}${path}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`link-${path.replaceAll("/", "-")}-${response.status}`);
    return parsed;
  };

  // The poll announces what this fleet can reach, so the phone's TALK TO list is
  // the fleet's own config and not a Cloudflare variable (row 184). The list is
  // read fresh each cycle, but only SENT when it changed, or once an hour so the
  // worker's announce window can never expire it: sixty-five upserts every
  // fifteen seconds would be three quarters of a million D1 row writes a day for
  // a list that changes a few times a week.
  const announced = announcedTargetList(targets);
  const announceHash = listFingerprint(announced);
  const announceDue = journal.announce?.hash !== announceHash
    || !Number.isFinite(journal.announce?.atMs)
    || Date.now() - journal.announce.atMs >= ANNOUNCE_REFRESH_MS;
  const claimed = await post(
    "/api/link/connector/poll?source=wsl",
    announceDue ? { targets: announced } : {},
  );
  if (announceDue) {
    // Recorded only after the worker accepted the poll, so a failed cycle
    // announces again instead of trusting an unsent list.
    journal.announce = { hash: announceHash, atMs: Date.now() };
    const stamped = readJournal(statePath);
    stamped.announce = journal.announce;
    writeJournal(statePath, stamped);
  }
  const messages = Array.isArray(claimed.messages) ? claimed.messages : [];
  let handled = 0;
  const started = [];
  for (const message of messages) {
    const id = String(message.clientMessageId || "");
    const plan = planClaimedMessage({ message, journalEntry: journal.messages[id] });
    if (plan.action === "skip") continue;
    try {
      if (plan.action === "deliver") {
        const onPane = await deliverOneTurn({
          message, id, journal, statePath, fetchImpl, serviceBase, auth, transcribe,
          deliveryBroker, deliveryQueue, receiptTimeoutMs, sleep, post, connectorId, log,
        });
        if (!onPane) continue;
      }
      // The pane already has this turn, but the mailbox row does not say so: the
      // ack was lost on its way. Re-acking is not re-delivering; nothing is
      // written to the pane, and the reply below would be refused without it.
      if (plan.needsAck) {
        await post("/api/link/connector/ack", { clientMessageId: id, connectorId });
        journal.messages[id] = updateJournal(statePath, id, { ackRepairedAt: Date.now() });
      }
      if (plan.action === "repost-reply") {
        await post("/api/link/connector/reply", { clientMessageId: id, connectorId, body: plan.reply });
        journal.messages[id] = updateJournal(statePath, id, { replyRepostedAt: Date.now() });
        handled += 1;
        continue;
      }
      // The reply is waited for beside the cycle, not inside it. A message the
      // worker re-claims while its wait runs is already covered by that wait.
      if (replyWaits.has(id)) continue;
      const wait = awaitOneReply({
        id,
        target: journal.messages[id]?.target || message.target,
        prompt: journal.messages[id]?.prompt || linkTurnPrompt(message),
        agent,
        post,
        connectorId,
        statePath,
        replyTimeoutMs,
        sleep,
        attempts: Number(message.attempts || 1),
        log,
        waits: replyWaits,
      // Nobody awaits this in production, so it must never reject: an unhandled
      // rejection would take the bridge down for one pane's slow answer.
      }).catch((error) => {
        log(`link-connector ${id} reply-wait-crashed ${String(error?.message || error)}`);
        replyWaits.delete(id);
        return false;
      });
      replyWaits.set(id, wait);
      started.push(wait);
      handled += 1;
    } catch (error) {
      const disposition = connectorFailureDisposition(error, Number(message.attempts || 1));
      const { stage } = disposition;
      log(`link-connector ${id} failed:${stage} ${String(error?.message || error)}`);
      if (disposition.terminal) {
        await post("/api/link/connector/fail", { clientMessageId: id, connectorId, error: stage }).catch(() => {});
        journal.messages[id] = updateJournal(statePath, id, { stage: "failed", error: stage });
      }
    }
  }
  // `started` is what this cycle handed off; production ignores it and the
  // next poll follows in 15 s, tests await it to see the reply land.
  return { claimed: messages.length, handled, started, pending: pendingReplyWaits(replyWaits) };
}

/** WHAT: Checks the durable broker until one job has an ingest outcome. WHY: Prevents a merely enqueued job from being reported as delivered. */
export async function waitForBrokerReceipt({ queue, agentName, pane, jobId, timeoutMs = 120_000, sleep }) {
  if (!queue?.read || !jobId) {
    return { delivered: false, terminal: "receipt-unavailable" };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = queue.read(agentName, pane, jobId);
    if (job?.status === "acknowledged" && Number.isFinite(job.acknowledgedAt)) {
      return { delivered: true, job };
    }
    if (job?.status === "cancelled" || job?.status === "delivered_unverified") {
      return { delivered: false, terminal: job.status, job };
    }
    await sleep(1_000);
  }
  return { delivered: false, terminal: null, timeout: true };
}

/** WHAT: Fetches one pane reply within a bound. WHY: Keeps a slow turn from blocking the connector forever. */
export async function waitForLinkReply({ agent, target, prompt, replyTimeoutMs, sleep }) {
  const agentName = String(target).split(":")[0];
  const pane = Number(String(target).split(":")[1]);
  const deadline = Date.now() + replyTimeoutMs;
  while (Date.now() < deadline) {
    if (agent.hasResponseForPrompt(agentName, pane, prompt)) {
      const result = await agent.getResponseStreamWithRaw(agentName, pane, prompt);
      const parts = (result.items || [])
        .filter((item) => item.type === "text")
        .map((item) => String(item.content || "").trim())
        .filter(Boolean);
      if (parts.length) return parts.join("\n\n").slice(0, 4000);
    }
    await sleep(2_000);
  }
  throw new Error("reply-timeout");
}
