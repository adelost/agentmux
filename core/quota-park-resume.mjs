// Resumes Claude panes that the quota park stopped, as soon as their account has room again.
// lsrc:0 2026-10-19: the park told ten Claude S panes that their week stopped them until 03:59Z, and they ended
// their turns. A free reset gave the account room at 20:26Z, but limit recovery follows only limit receipts and
// parked queue jobs, and these panes had neither, so nothing resumed them.

import { accountWindows, parkResumeDecision, QUOTA_PARK_HEADER, QUOTA_PARK_POLICY } from "./quota-park.mjs";
import { quotaRecoveryContinuation } from "./claude-quota-recovery.mjs";
import { latestPaneSessionIdentity } from "./native-session-identity.mjs";
import { parseJsonlWindow } from "./jsonl-reader.mjs";
import { userPromptText } from "./claude-turn-lifecycle.mjs";
import { isClaudeTurnBusy } from "./claude-turn-busy.mjs";
import { DELIVERED_UNVERIFIED_STATE, TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { SELF_COMPACT_POLICY } from "./self-compact.mjs";

const readingTime = (quota) => Date.parse(quota?.fetchedAt || quota?.observation?.observedAt || "");
const isParkNotice = (job) => job.source === "self-compact" && String(job.text || "").startsWith(QUOTA_PARK_HEADER);

/**
 * WHAT: Checks whether the park's handoff reached the pane, still waits in its queue, or was lost.
 * WHY: Keeps a pane that was never told to stop from a resume.
 */
function parkNotice(park, jobs, now) {
  const parkedAt = Date.parse(park.parkedAt);
  const job = jobs.filter((candidate) => isParkNotice(candidate) && Number(candidate.createdAt) >= parkedAt)
    .sort((left, right) => left.createdAt - right.createdAt)[0];
  if (!job) {
    return now - parkedAt < SELF_COMPACT_POLICY.expiresMs
      ? { state: "waiting", reason: "its park compact has not run yet" }
      : { state: "lost", reason: "no park notice reached it" };
  }
  if (job.status === "acknowledged" || job.status === DELIVERED_UNVERIFIED_STATE) return { state: "sent", job };
  if (TERMINAL_DELIVERY_STATES.has(job.status)) {
    return { state: "lost", reason: `its park notice ended ${job.status}: ${job.lastReason || "no reason given"}` };
  }
  // The quota floor holds the notice of a pane parked at the floor until its account has room again.
  return { state: "queued", job };
}

/** WHAT: Names a session change since the park, or returns null. WHY: Keeps the same-session prompt out of another session. */
function sessionChanged(park, identityFor) {
  const before = park.identity || {};
  const current = identityFor("claude", before.dir);
  return !current || current.sessionId !== before.sessionId || current.path !== before.path ? "its session changed since the park" : null;
}

/** WHAT: Reads the prompt of a Claude session's last turn and whether that turn still runs. WHY: Keeps a resume out of a running turn. */
function lastTurn(path) {
  const events = parseJsonlWindow(path);
  const index = events.findLastIndex((event) => userPromptText(event) !== null);
  return index < 0 ? null : { prompt: userPromptText(events[index]), busy: isClaudeTurnBusy(events, index, { sessionPath: path }) };
}

/**
 * WHAT: Checks each open park and queues the same-session recovery prompt once its account has room.
 * WHY: Keeps a parked pane from idling after an early reset that no limit receipt announces.
 */
export async function resumeParkedPanes({
  store, queue, activeReceipt, readQuota,
  identityFor = latestPaneSessionIdentity, floorPercent = QUOTA_PARK_POLICY.leftPercent, now = Date.now, resetGraceMs = 15_000,
  log = () => {},
}) {
  // Room means more than the floor left: the same number the park and the delivery floor use.
  const policy = { ...QUOTA_PARK_POLICY, leftPercent: floorPercent };
  const results = [];
  for (const park of store.list()) {
    if (park.state !== "parked") continue;
    try { results.push(await visit(park)); }
    catch (error) { log(`${park.agentName}:${park.pane} quota park resume failed: ${error.message}`); }
  }
  return results;

  function settle(park, fields, action) {
    const settled = store.update(park, fields);
    return { agentName: park.agentName, pane: park.pane, action: settled?.parkedAt === park.parkedAt ? action : "wait",
      reason: settled?.parkedAt === park.parkedAt ? fields.reason : "a newer park replaced this one" };
  }

  async function visit(park) {
    const { agentName, pane } = park;
    const waiting = (reason) => ({ agentName, pane, action: "wait", reason });
    // A pane its account stopped at the banner belongs to limit recovery, which restarts it in its session.
    if (activeReceipt(agentName, pane)) return waiting("limit recovery owns its stop");
    let unsentNotice = null;
    if (!park.noticeJobId) {
      const notice = parkNotice(park, queue.list(agentName, pane), now());
      if (notice.state === "lost") return settle(park, { state: "dropped", reason: notice.reason }, "drop");
      if (notice.state === "waiting") return waiting(notice.reason);
      if (notice.state === "queued") unsentNotice = notice.job;
      else {
        const noted = store.update(park, { noticeJobId: notice.job.id });
        if (noted?.parkedAt !== park.parkedAt) return waiting("a newer park replaced this one");
        park = noted;
      }
    }
    const changed = sessionChanged(park, identityFor);
    if (changed) return settle(park, { state: "dropped", reason: changed }, "drop");
    const idempotencyKey = `quota-park-resume:${agentName}:${pane}:${park.parkedAt}`;
    const quota = await readQuota({ agentName, pane, notBefore: Date.parse(park.parkedAt) });
    const decision = parkResumeDecision({ park, windows: quota?.ok ? accountWindows(quota) : null, observedAt: readingTime(quota),
      activity: () => {
        const queued = queue.list(agentName, pane).find((job) => !TERMINAL_DELIVERY_STATES.has(job.status)
          && !isParkNotice(job) && job.idempotencyKey !== idempotencyKey);
        return { queued, turn: queued ? null : lastTurn(park.identity.path) };
      },
      now: now(), resetGraceMs }, policy);
    if (decision.action === "wait") return waiting(unsentNotice ? `${decision.reason}; its park notice waits in the queue` : decision.reason);
    // Room is back either way: its stale "stops you until" notice never arrives, and the broker ends it before any paste.
    if (unsentNotice) {
      queue.requestCancellation(unsentNotice.id, { requestedBy: "quota-recovery",
        reason: `its account has room again; ${decision.action === "drop" ? decision.reason : "the same-session recovery prompt replaces the park notice"}` });
    }
    if (decision.action === "drop") return settle(park, { state: "dropped", reason: decision.reason }, "drop");
    const job = queue.enqueue({
      agentName, pane, text: quotaRecoveryContinuation(), source: "quota-recovery", idempotencyKey,
      orderKey: `0000000000000000:${idempotencyKey}`,
      metadata: { quotaParkResume: { parkedAt: park.parkedAt, window: park.window, account: park.account?.name || null } },
    });
    log(`${agentName}:${pane} resumed after its quota park: ${decision.reason}`);
    return settle(park, { state: "resumed", reason: decision.reason, jobId: job.id, resumedAt: new Date(now()).toISOString() },
      "resume");
  }
}
