// WSL Link connector: outbound poller that carries mailbox messages to
// panes through the durable amux queue and posts replies back. It journals
// locally before every ack so a restart can never double-ack or double-reply.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const JOURNAL_VERSION = 1;

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

/** WHAT: Builds the pane prompt for one mailbox message. WHY: Keeps the reply correlation anchored to one exact marker. */
export function linkTurnPrompt({ clientMessageId, body }) {
  return `[amux-link-turn:${clientMessageId}]\n${String(body || "").trim()}`;
}

/** WHAT: Maps one claimed message against the journal to its next step. WHY: Prevents a restart from re-acking or re-replying finished work. */
export function planClaimedMessage({ message, journalEntry }) {
  if (journalEntry?.stage === "replied") return { action: "skip", reason: "already-replied-locally" };
  if (journalEntry?.stage === "delivered") return { action: "await-reply", message };
  return { action: "deliver", message };
}

/** WHAT: Maps a fetch or pane failure to an honest connector report. WHY: Keeps a dead mailbox or pane from masquerading as a delivered turn. */
export function connectorFailureStage(error) {
  const text = String(error?.message || error || "unknown");
  if (/fetch|network|ECONN|timeout|5\d\d/u.test(text)) return "link-unavailable";
  return "pane-delivery-failed";
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
} = {}) {
  const journal = readJournal(statePath);
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const post = async (path, body) => {
    const response = await fetchImpl(`${linkBase}${path}`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(30_000),
    });
    const parsed = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`link-${path.replaceAll("/", "-")}-${response.status}`);
    return parsed;
  };

  const claimed = await post("/api/link/connector/poll?source=wsl");
  const messages = Array.isArray(claimed.messages) ? claimed.messages : [];
  let handled = 0;
  for (const message of messages) {
    const id = String(message.clientMessageId || "");
    const plan = planClaimedMessage({ message, journalEntry: journal.messages[id] });
    if (plan.action === "skip") continue;
    try {
      if (plan.action === "deliver") {
        let body = String(message.body || "").trim();
        if (message.kind === "voice" && message.voiceRef) {
          const audio = await fetchImpl(`${linkBase}/api/link/voice/${message.voiceRef}`, {
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
        journal.messages[id] = { stage: "claimed", at: Date.now(), target: message.target, prompt };
        writeJournal(statePath, journal);
        // The stable key is the dedup: the durable queue atomically returns
        // the existing job for a reused key. Only a proven cancelled job
        // earns a rotated key; a live or unproven job keeps its single pane
        // write and can never duplicate on reclaim.
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
          continue;
        }
        journal.messages[id] = { ...journal.messages[id], stage: "enqueued", jobId: job?.id || null };
        writeJournal(statePath, journal);
        // A merely enqueued job is not delivered: ack only on the broker's
        // acknowledged ingest receipt. Cancelled or timed out stays leased,
        // so the reclaim path keeps it recoverable without a false ack.
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
          continue;
        }
        await post("/api/link/connector/ack", { clientMessageId: id, connectorId });
        journal.messages[id] = { ...journal.messages[id], stage: "delivered" };
        writeJournal(statePath, journal);
      }
      const prompt = journal.messages[id]?.prompt || linkTurnPrompt(message);
      const replyText = await waitForLinkReply({
        agent,
        target: journal.messages[id]?.target || message.target,
        prompt,
        replyTimeoutMs,
        sleep,
      });
      await post("/api/link/connector/reply", { clientMessageId: id, connectorId, body: replyText });
      journal.messages[id] = { ...journal.messages[id], stage: "replied", replyAt: Date.now() };
      writeJournal(statePath, journal);
      handled += 1;
    } catch (error) {
      const stage = connectorFailureStage(error);
      log(`link-connector ${id} failed:${stage} ${String(error?.message || error)}`);
      if (stage === "pane-delivery-failed") {
        await post("/api/link/connector/fail", { clientMessageId: id, connectorId, error: stage }).catch(() => {});
        journal.messages[id] = { ...journal.messages[id], stage: "failed", error: stage };
        writeJournal(statePath, journal);
      }
    }
  }
  return { claimed: messages.length, handled };
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
