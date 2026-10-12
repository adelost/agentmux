import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { captureJsonlAppendCursor, hasJsonlEventAfterCursor } from "./jsonl-append-cursor.mjs";
import { codexUserPrompt } from "./codex-user-events.mjs";
import { extractPromptFromEvent } from "./claude-prompt-text.mjs";
import { latestPaneSessionIdentity } from "./native-session-identity.mjs";
import { TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { findBlockingPrompt } from "./dismiss.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const authoredInput = event => codexUserPrompt(event) !== null || (event.type === "user" && !event.isMeta && !event.isCompactSummary
  && ((extractPromptFromEvent(event) !== null
    && !/^\s*(?:\/[a-z][\w:-]*(?:\s|$)|<(?:local-command|command-))/iu.test(extractPromptFromEvent(event)))
    || event.message?.content?.some?.(part => part.type === "image")));

/** WHAT: Checks input after the saved checkpoint, within a hard read bound. WHY: A missing or oversized evidence window cannot authorize stale work. */
function inputAfter(path, cursor) {
  const offset = cursor?.positions?.[path], size = statSync(path).size;
  if (!Number.isFinite(offset) || offset < 0 || offset > size || size - offset > MAX_BYTES) {
    throw new Error("self-compact continuation evidence is unavailable or exceeds eight MiB");
  }
  return hasJsonlEventAfterCursor([path], cursor, authoredInput, { maxScanBytes: MAX_BYTES });
}

/** WHAT: Checks whether new input/session replaced an agent's own task. WHY: Prevents continuation from overriding a later request. */
export function selfCompactSuperseded(request, { identityFor = latestPaneSessionIdentity, queue, ownJobId = null }) {
  if (!request.continuation) return false;
  const before = request.identity, current = identityFor(before.engine, before.dir);
  if (current?.sessionId !== before.sessionId || current.path !== before.path) return true;
  if (queue.list(request.agent, request.pane).some(job => job.id !== ownJobId && !TERMINAL_DELIVERY_STATES.has(job.status))) return true;
  return inputAfter(before.path, request.cursor);
}

/** WHAT: Routes a verified checkpoint handoff through the durable queue. WHY: Prevents lost or duplicate handoffs across either crash boundary. */
export function finishSelfCompactRequest(request, ending, { store, queue, identityFor, receiptFor }) {
  const latest = store.read(request.agent, request.pane);
  if (!latest || latest.requestedAt !== request.requestedAt || latest.focus !== request.focus) return ending;
  let result = ending;
  if (request.continuation && ["compacted", "satisfied"].includes(ending.outcome)) {
    const receipt = receiptFor(request.agent, request.pane, request.identity);
    const afterCheckpoint = receipt?.status === "VERIFIED" && receipt.sessionId === request.identity.sessionId
      && receipt.at >= Date.parse(request.requestedAt)
      && receipt.cursor?.positions?.[request.identity.path] >= request.cursor.positions[request.identity.path];
    if (!afterCheckpoint) return { ...ending, outcome: "held", detail: "waiting for a verified compact after this checkpoint" };
    const key = `self-compact:${request.agent}:${request.pane}:${request.requestedAt}:`
      + createHash("sha256").update(request.continuation).digest("hex").slice(0, 16);
    const existing = queue.list(request.agent, request.pane).find(job => job.idempotencyKey === key);
    if (!existing && selfCompactSuperseded(request, { identityFor, queue })) {
      result = { ...ending, outcome: "satisfied", detail: "new input or session superseded the saved handoff" };
    } else {
      const job = existing || queue.enqueue({ agentName: request.agent, pane: request.pane, kind: "prompt", source: "self-compact",
        text: request.continuation, idempotencyKey: key, metadata: { selfCompactContinuation: {
          ...request.identity, cursor: captureJsonlAppendCursor("self-compact-resume-v1", [request.identity.path]),
        } } });
      result = { ...ending, continuationJobId: job.id };
    }
  }
  store.clear(request.agent, request.pane);
  return result;
}

/** WHAT: Checks queued checkpoint continuations before their first physical submit. WHY: Prevents a saved handoff from overriding later input. */
export async function fenceSelfCompactJobs({ agentName, pane, queue, agent, now, terminalizeNotSent, log, identityFor = latestPaneSessionIdentity }) {
  for (const job of queue.list(agentName, pane)) {
    const context = job.metadata?.selfCompactContinuation;
    if (job.source !== "self-compact" || !context || job.status !== "pending" || job.attempts > 0 || job.draftOwned) continue;
    try {
      const transport = await agent.promptTransportState(agentName, pane, job.text);
      if (transport.state !== "empty-idle" || transport.busy || await agent.isBusy(agentName, pane)
          || findBlockingPrompt(await agent.captureScreen(agentName, pane))) {
        queue.update(job, { nextAttemptAt: now() + 15_000, lastReason: "checkpoint handoff waits for an idle composer" });
        continue;
      }
      const superseded = selfCompactSuperseded({ agent: agentName, pane, continuation: job.text, identity: context, cursor: context.cursor },
        { identityFor, queue, ownJobId: job.id });
      if (superseded) {
        queue.requestCancellation(job.id, { requestedBy: "delivery-broker", reason: "checkpoint handoff superseded by new input or session" });
        await terminalizeNotSent(queue.read(agentName, pane, job.id));
      }
    } catch (error) {
      log(`checkpoint handoff held: ${error.message}`);
      queue.update(job, { nextAttemptAt: now() + 15_000, lastReason: error.message });
    }
  }
}
