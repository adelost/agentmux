import { QUOTA_FLOOR_ALERT_STATE } from "./quota-floor-alert.mjs";
import { isUnsentQuotaFloorJob, isUnsubmittedQuotaJob } from "./quota-floor-job.mjs";

/** WHAT: Checks whether a job still blocks maintenance under the session lease. WHY: Prevents pending labels from hiding submission fences or an unknown outcome. */
export function blocksQuotaCompact(job, { jobId, beforeDelivery, hold }) {
  if (job.id === jobId && isUnsubmittedQuotaJob(job)) return false;
  if (beforeDelivery && job.status === "pending" && isUnsubmittedQuotaJob(job)) return false;
  return !hold?.permits(job);
}

/** WHAT: Reads the existing quota episode that owns this pane's unsent holds. WHY: Prevents missing or ambiguous account evidence from granting a compact exception. */
export function warmQuotaHold(state, name, pane, jobs) {
  const paneKey = `${name}:${pane}`, accounts = state?.get?.(QUOTA_FLOOR_ALERT_STATE)?.accounts || {};
  const candidates = Object.entries(accounts).filter(([, episode]) => episode.status === "held" && episode.panes?.includes(paneKey)
    && jobs.some(job => isUnsubmittedQuotaJob(job) && episode.jobs?.includes(job.id)
      && (!job.lastReason || isUnsentQuotaFloorJob(job) && String(job.lastReason).startsWith(`wake-refused:quota-floor: ${episode.name} `))));
  if (candidates.length !== 1) return null;
  const [key, episode] = candidates[0];
  return { key, id: episode.id, paneKey,
    attempts: episode.warmCompactions?.[paneKey]?.attempts || [],
    permits: job => isUnsubmittedQuotaJob(job) && episode.jobs.includes(job.id)
      && (!job.lastReason || isUnsentQuotaFloorJob(job) && String(job.lastReason).startsWith(`wake-refused:quota-floor: ${episode.name} `)) };
}

/** WHAT: Stores one of two compact attempt claims in the existing account episode. WHY: Prevents new sessions or bridge reloads from resetting the pane's quota budget. */
export function claimQuotaCompact(state, hold, sessionId, now) {
  let claim = null;
  if (!state?.updateKey) return null;
  state.updateKey(QUOTA_FLOOR_ALERT_STATE, data => {
    const episode = data?.accounts?.[hold.key];
    if (episode?.id !== hold.id || episode.status !== "held") return data;
    episode.warmCompactions ??= {};
    const record = episode.warmCompactions[hold.paneKey] ||= { attempts: [] };
    if (record.attempts.length >= 2 || record.attempts.some(attempt => ["attempting", "unknown"].includes(attempt.status))) return data;
    const attempt = { number: record.attempts.length + 1, at: now, sessionId, status: "attempting" };
    record.attempts.push(attempt);
    claim = { key: hold.key, episodeId: hold.id, paneKey: hold.paneKey, ...attempt };
    return data;
  });
  return claim;
}

/** WHAT: Stores a compact outcome inside its original episode. WHY: Keeps the existing quota notice sourced without creating another alert or delivery. */
export function finishQuotaCompact(state, claim, status, reason, now) {
  if (!claim || !state?.updateKey) return;
  state.updateKey(QUOTA_FLOOR_ALERT_STATE, data => {
    const episode = data?.accounts?.[claim.key];
    if (episode?.id !== claim.episodeId) return data;
    const attempt = episode.warmCompactions?.[claim.paneKey]?.attempts?.find(item => item.number === claim.number && item.at === claim.at);
    if (attempt) Object.assign(attempt, { status, reason: reason || null, finishedAt: now });
    return data;
  });
}
