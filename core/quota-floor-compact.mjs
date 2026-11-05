import { QUOTA_FLOOR_ALERT_STATE } from "./quota-floor-alert.mjs";
import { isUnsentQuotaFloorJob, isUnsubmittedQuotaJob } from "./quota-floor-job.mjs";
import { COMPACT_RECEIPTS_STATE, compactReceipt, quotaCompactRecords, reconcileQuotaCompactions, updateCompactReceipt } from "./compact-receipts.mjs";

/** WHAT: Checks whether a job still blocks maintenance under the session lease. WHY: Prevents pending labels from hiding submission fences or an unknown outcome. */
export function blocksQuotaCompact(job, { jobId, beforeDelivery, hold }) {
  if (job.id === jobId && isUnsubmittedQuotaJob(job)) return false;
  if (beforeDelivery && job.status === "pending" && isUnsubmittedQuotaJob(job)) return false;
  return !hold?.permits(job);
}

/** WHAT: Reads the existing quota episode that owns this pane's unsent holds. WHY: Prevents missing or ambiguous account evidence from granting a compact exception. */
export function warmQuotaHold(state, name, pane, jobs, now = Date.now()) {
  const paneKey = `${name}:${pane}`, accounts = state?.get?.(QUOTA_FLOOR_ALERT_STATE)?.accounts || {};
  const candidates = Object.entries(accounts).filter(([, episode]) => episode.status === "held" && episode.panes?.includes(paneKey)
    && jobs.some(job => isUnsubmittedQuotaJob(job) && episode.jobs?.includes(job.id)
      && (!job.lastReason || isUnsentQuotaFloorJob(job) && String(job.lastReason).startsWith(`wake-refused:quota-floor: ${episode.name} `))));
  if (candidates.length !== 1) return null;
  const [key, episode] = candidates[0];
  reconcileQuotaCompactions(state, episode, now, QUOTA_FLOOR_ALERT_STATE);
  return { key, id: episode.id, paneKey,
    attempts: quotaCompactRecords(state, episode)[paneKey]?.attempts || [],
    permits: job => isUnsubmittedQuotaJob(job) && episode.jobs.includes(job.id)
      && (!job.lastReason || isUnsentQuotaFloorJob(job) && String(job.lastReason).startsWith(`wake-refused:quota-floor: ${episode.name} `)) };
}

/** WHAT: Stores one of two compact attempt claims in the existing account episode. WHY: Prevents new sessions or bridge reloads from resetting the pane's quota budget. */
export function claimQuotaCompact(state, hold, sessionId, now) {
  let claim = null;
  if (!state?.updateAll) return null;
  state.updateAll(data => {
    const episode = data[QUOTA_FLOOR_ALERT_STATE]?.accounts?.[hold.key];
    if (episode?.id !== hold.id || episode.status !== "held") return;
    const records = data[COMPACT_RECEIPTS_STATE] ||= {}, record = records[hold.paneKey] ||= {};
    record.quotaCompactions ||= {};
    const attempts = record.quotaCompactions[episode.id] ||= episode.warmCompactions?.[hold.paneKey]?.attempts || [];
    if (episode.warmCompactions) {
      delete episode.warmCompactions[hold.paneKey];
      if (!Object.keys(episode.warmCompactions).length) delete episode.warmCompactions;
    }
    if (attempts.length >= 2 || attempts.some(attempt => ["attempting", "unknown"].includes(attempt.status))) return;
    const attempt = { number: attempts.length + 1, at: now, sessionId, status: "attempting" };
    attempts.push(attempt);
    claim = { key: hold.key, episodeId: hold.id, paneKey: hold.paneKey, ...attempt };
  });
  return claim;
}

/** WHAT: Stores a compact outcome inside its original episode. WHY: Keeps the existing quota notice sourced without creating another alert or delivery. */
export function finishQuotaCompact(state, claim, status, reason, now) {
  if (!claim || !state?.updateKey || !compactReceipt(state, claim.paneKey)) return;
  updateCompactReceipt(state, claim.paneKey, record => {
    const attempt = record.quotaCompactions?.[claim.episodeId]?.find(item => item.number === claim.number && item.at === claim.at);
    if (attempt) Object.assign(attempt, { status, reason: reason || null, finishedAt: now });
    return record;
  });
}
