// Resumes Claude panes that the quota park stopped, as soon as their account has room again.
// lsrc:0 2026-10-19: the park told ten Claude S panes that their week stopped them until 03:59Z, and they ended
// their turns. A free reset gave the account room at 20:26Z, but limit recovery follows only limit receipts and
// parked queue jobs, and these panes had neither, so nothing resumed them.

import { accountWindows, parkResumeDecision, QUOTA_PARK_HEADER } from "./quota-park.mjs";
import { quotaRecoveryContinuation } from "./claude-quota-recovery.mjs";
import { authoredInputAfter } from "./self-compact-resume.mjs";
import { latestPaneSessionIdentity } from "./native-session-identity.mjs";
import { DELIVERED_UNVERIFIED_STATE, TERMINAL_DELIVERY_STATES } from "./delivery-queue-policy.mjs";
import { SELF_COMPACT_POLICY } from "./self-compact.mjs";

const readingTime = (quota) => Date.parse(quota?.fetchedAt || quota?.observation?.observedAt || "");

/** WHAT: Checks whether the park's handoff reached the pane, waits, or was lost. WHY: Keeps a pane that was never told to stop from a resume. */
function parkNotice(park, jobs, now) {
  const parkedAt = Date.parse(park.parkedAt);
  const job = jobs.filter((candidate) => candidate.source === "self-compact"
    && String(candidate.text || "").startsWith(QUOTA_PARK_HEADER) && Number(candidate.createdAt) >= parkedAt)
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
  return { state: "waiting", reason: "its park notice waits in the queue" };
}

/** WHAT: Names why a parked pane has moved on by itself, or returns null. WHY: Keeps a resume from overriding a later request. */
function newTurnSince(park, identityFor) {
  const before = park.identity || {};
  const current = identityFor("claude", before.dir);
  if (!current || current.sessionId !== before.sessionId || current.path !== before.path) return "its session changed since the park";
  try {
    return authoredInputAfter(before.path, park.cursor, { except: QUOTA_PARK_HEADER }) ? "started a new turn since its park" : null;
  } catch (error) {
    return `its session moved past the park checkpoint (${error.message})`;
  }
}

/**
 * WHAT: Checks each open park and queues the same-session recovery prompt once its account has room.
 * WHY: Keeps a parked pane from idling after an early reset that no limit receipt announces.
 */
export async function resumeParkedPanes({
  store, queue, activeReceipt, readQuota,
  identityFor = latestPaneSessionIdentity, now = Date.now, resetGraceMs = 15_000, log = () => {},
}) {
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
    if (!park.noticeJobId) {
      const notice = parkNotice(park, queue.list(agentName, pane), now());
      if (notice.state === "lost") return settle(park, { state: "dropped", reason: notice.reason }, "drop");
      if (notice.state === "waiting") return waiting(notice.reason);
      const noted = store.update(park, { noticeJobId: notice.job.id });
      if (noted?.parkedAt !== park.parkedAt) return waiting("a newer park replaced this one");
      park = noted;
    }
    const newTurn = newTurnSince(park, identityFor);
    const quota = newTurn ? null : await readQuota({ agentName, pane, notBefore: Date.parse(park.parkedAt) });
    const decision = parkResumeDecision({ park, windows: quota?.ok ? accountWindows(quota) : null,
      observedAt: readingTime(quota), newTurn, now: now(), resetGraceMs });
    if (decision.action === "wait") return waiting(decision.reason);
    if (decision.action === "drop") return settle(park, { state: "dropped", reason: decision.reason }, "drop");
    const idempotencyKey = `quota-park-resume:${agentName}:${pane}:${park.parkedAt}`;
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
